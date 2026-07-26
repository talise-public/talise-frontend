import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { rateLimitAsync } from "@/lib/rate-limit";
import { WATERX_ENABLED, WATERX_LOCAL_SIGN, localSigner, buildCloseTx, settle, friendlyPerpError, assertOwnsPerpAccount } from "@/lib/waterx";
import { awardForTx } from "@/lib/rewards/earn";
import { PERPS_CLOSE } from "@/lib/rewards-constants";
import { trackPerpClosed } from "@/lib/analytics/emit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/markets/close, close a perp position at market.
 * Body: { ticker, accountId, positionId, isLong }
 * Local mode executes with the dev key; otherwise returns sponsor-ready bytes.
 */
export async function POST(req: Request) {
  if (!WATERX_ENABLED) return NextResponse.json({ error: "Perps aren't enabled.", code: "PERPS_DISABLED" }, { status: 503 });

  let sender: string;
  let authedUserId: number | null = null;
  if (WATERX_LOCAL_SIGN && localSigner()) {
    sender = localSigner()!.toSuiAddress();
  } else {
    const userId = await readEntryIdFromRequest(req);
    authedUserId = userId ?? null;
    if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
    const denied = await denyUnlessAppApproved(userId);
    if (denied) return denied;
    const rl = await rateLimitAsync({ key: `perp:close:${userId}`, limit: 60, windowSec: 3600 });
    if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } });
    const user = await userById(userId);
    if (!user?.sui_address) return NextResponse.json({ error: "user not found" }, { status: 404 });
    sender = user.sui_address;
  }

  let b: { ticker?: string; accountId?: string; positionId?: string; isLong?: boolean };
  try { b = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const ticker = String(b.ticker ?? "");
  const accountId = String(b.accountId ?? "");
  const positionId = String(b.positionId ?? "");
  if (!ticker || !accountId || !positionId) {
    return NextResponse.json({ error: "ticker, accountId, positionId required" }, { status: 400 });
  }
  // MONEY-SAFETY (audit H13): accountId is client-supplied. Bind it to the
  // authenticated user so nobody can close another trader's position.
  if (authedUserId != null && !(await assertOwnsPerpAccount(authedUserId, accountId))) {
    return NextResponse.json({ error: "account does not belong to this user" }, { status: 403 });
  }

  try {
    const { tx, feeUsd } = await buildCloseTx(ticker, accountId, positionId, b.isLong ?? true, sender);
    const result = await settle(tx, sender);

    // REWARDS: closing a position earns points, fire-and-forget.
    //
    // `feeUsd` is the 2% Talise close fee that `buildCloseTx` computed from
    // the position's ON-CHAIN collateral and appended to this very PTB as a
    // USDsui transfer to the treasury. It is > 0 only when the fee leg is
    // actually in the transaction (buildCloseTx zeroes it when the user's
    // wallet can't cover it, and closes without it), so it is the honest
    // upper bound on what a close can be worth.
    //
    // We pass it as the ASSERTED amount, which the engine treats as a ceiling
    // and never as a value: it re-reads the settled tx and pays on the USDsui
    // the treasury address was actually credited (lib/rewards/earn.ts →
    // shapeBasis). Nothing about position size, entry price or PnL is trusted,
    // or even sent — none of it is verifiable on chain, because a reduce-only
    // close settles into the WaterX Account object's internal credit balance
    // and produces no coin balance change.
    //
    // The digest is only available in the local-sign path; in the normal
    // SPONSORED path we hand the client unsigned bytes and never learn the
    // digest, so the award is booked digest-less and the deferred settlement
    // pass finds the close by its on-chain shape (fee-only outflow to the
    // treasury) on the next app-open. That shape requirement is what stops a
    // deferred perps award from latching onto an unrelated send.
    if (authedUserId != null && feeUsd >= PERPS_CLOSE.MIN_FEE_USD) {
      void awardForTx({
        userId: authedUserId,
        trigger: "perps_close",
        amountUsd: feeUsd,
        digest: result.mode === "executed" ? result.digest : undefined,
        venue: "waterx",
      }).catch((e) =>
        console.warn(`[perp/close] awardForTx failed: ${(e as Error).message}`)
      );
    }

    // GROWTH + REVENUE. `feeUsd` here is the ONLY fee in the whole app that the
    // server observes rather than derives: `buildCloseTx` computed it from the
    // position's ON-CHAIN collateral and appended it to this PTB as a USDsui
    // transfer to the treasury, and it is 0 when that leg was dropped. So this is
    // the one `revenue_events` row written with `derived: false`.
    //
    // GATED ON `mode === "executed"`. That branch is the local-signing path,
    // where the transaction has actually settled and we hold its digest. In the
    // SPONSORED path `settle()` returns unsigned bytes: the position is NOT yet
    // closed and no digest exists, so booking revenue there would be recording a
    // fee for a trade that may never land, and there is no natural idempotency
    // key to dedupe a retry against. Emitting it correctly needs the client to
    // report the close back after signing (see METRICS.md, "not wired").
    if (authedUserId != null && result.mode === "executed") {
      trackPerpClosed(authedUserId, {
        feeUsd,
        ref: result.digest,
        ticker,
      });
    }

    return NextResponse.json({ ...result, ticker, positionId, feeUsd });
  } catch (err) {
    const msg = (err as Error).message ?? "failed";
    console.warn(`[perp/close] failed: ${msg}`);
    return NextResponse.json({ error: friendlyPerpError(msg), raw: msg }, { status: 500 });
  }
}
