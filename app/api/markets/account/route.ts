import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { rateLimitAsync } from "@/lib/rate-limit";
import {
  WATERX_ENABLED, WATERX_LOCAL_SIGN, localSigner,
  buildCreateAccountTx, buildDepositTx, buildWithdrawTx, settle, findCreatedAccountId, accountSnapshot,
  getStoredAccount, storeAccount, usdsuiBalanceUsd, friendlyPerpError,
} from "@/lib/waterx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Resolve the acting identity: dev key in local mode, else the authed user.
async function resolveActor(req: Request): Promise<
  | { ok: true; sender: string; userId: number | null }
  | { ok: false; res: NextResponse }
> {
  if (WATERX_LOCAL_SIGN && localSigner()) {
    return { ok: true, sender: localSigner()!.toSuiAddress(), userId: null };
  }
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return { ok: false, res: NextResponse.json({ error: "not authenticated" }, { status: 401 }) };
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return { ok: false, res: denied };
  const user = await userById(userId);
  if (!user?.sui_address) return { ok: false, res: NextResponse.json({ error: "user not found" }, { status: 404 }) };
  return { ok: true, sender: user.sui_address, userId };
}

/**
 * GET /api/markets/account, the caller's remembered waterx_account + snapshot.
 * Query overrides: ?accountId=0x… (snapshot a specific id), ?digest=… (resolve a
 * freshly-created account from its tx).
 */
export async function GET(req: Request) {
  if (!WATERX_ENABLED) return NextResponse.json({ error: "Perps aren't enabled.", code: "PERPS_DISABLED" }, { status: 503 });
  const url = new URL(req.url);
  const qDigest = url.searchParams.get("digest");
  const qAccount = url.searchParams.get("accountId");

  const actor = await resolveActor(req);
  if (!actor.ok) return actor.res;

  try {
    if (qDigest) {
      const accountId = await findCreatedAccountId(qDigest);
      if (accountId && actor.userId != null) await storeAccount(actor.userId, accountId);
      return NextResponse.json({ accountId });
    }
    const accountId = qAccount ?? (actor.userId != null ? await getStoredAccount(actor.userId) : null);
    if (!accountId) return NextResponse.json({ accountId: null, address: actor.sender });
    // Fresh every time so deposits + open/close reflect immediately. The read is
    // cheap because getPositions only scans the account's active markets.
    const snap = await accountSnapshot(accountId);
    return NextResponse.json({ accountId, address: actor.sender, ...snap });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message ?? "read failed" }, { status: 502 });
  }
}

/**
 * POST /api/markets/account
 *   { op: "create", alias? }              → build/execute create-account
 *   { op: "link", digest, accountId? }    → remember the account from a signed tx
 *   { op: "deposit", accountId, amountUsd } → deposit USDsui as collateral
 *
 * Web (sponsored) returns { mode:"sponsored", bytes } to sign via zkLogin; the
 * client then calls op:"link" with the resulting digest. Local mode executes
 * server-side and resolves the account id inline.
 */
export async function POST(req: Request) {
  if (!WATERX_ENABLED) return NextResponse.json({ error: "Perps aren't enabled.", code: "PERPS_DISABLED" }, { status: 503 });

  const actor = await resolveActor(req);
  if (!actor.ok) return actor.res;
  if (actor.userId != null) {
    const rl = await rateLimitAsync({ key: `perp:acct:${actor.userId}`, limit: 40, windowSec: 3600 });
    if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } });
  }

  let b: { op?: string; alias?: string; accountId?: string; amountUsd?: number; digest?: string };
  try { b = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const op = String(b.op ?? "");

  try {
    if (op === "create") {
      const tx = await buildCreateAccountTx(String(b.alias ?? "Talise"));
      const result = await settle(tx, actor.sender);
      if (result.mode === "executed") {
        const accountId = await findCreatedAccountId(result.digest);
        if (accountId && actor.userId != null) await storeAccount(actor.userId, accountId);
        return NextResponse.json({ ...result, op, accountId });
      }
      return NextResponse.json({ ...result, op });
    }

    if (op === "link") {
      const accountId = b.accountId ?? (b.digest ? await findCreatedAccountId(String(b.digest)) : null);
      if (!accountId) return NextResponse.json({ error: "could not resolve account" }, { status: 422 });
      if (actor.userId != null) await storeAccount(actor.userId, accountId);
      return NextResponse.json({ op, accountId });
    }

    if (op === "deposit") {
      const accountId = String(b.accountId ?? "");
      const amountUsd = Number(b.amountUsd ?? 0);
      if (!accountId || amountUsd <= 0) return NextResponse.json({ error: "accountId and amountUsd required" }, { status: 400 });
      // Pre-check the wallet has the USDsui, the deposit sources it from the
      // user's Talise balance, so fail fast with a clear message instead of a
      // raw on-chain "no valid coins" revert.
      const walletUsd = await usdsuiBalanceUsd(actor.sender);
      if (walletUsd + 0.001 < amountUsd) {
        return NextResponse.json({ error: `Not enough USDsui, you have $${walletUsd.toFixed(2)}.`, code: "INSUFFICIENT_USDSUI" }, { status: 400 });
      }
      const tx = await buildDepositTx(accountId, amountUsd);
      const result = await settle(tx, actor.sender);
      return NextResponse.json({ ...result, op, accountId, amountUsd });
    }

    if (op === "withdraw") {
      const accountId = String(b.accountId ?? "");
      const amountUsd = Number(b.amountUsd ?? 0);
      if (!accountId || amountUsd <= 0) return NextResponse.json({ error: "accountId and amountUsd required" }, { status: 400 });
      // Withdraw CREDIT → USDsui to the user's own Sui address (keeper-settled).
      // The build caps to on-chain spendable and returns the actual amount.
      const { tx, amountUsd: actualUsd } = await buildWithdrawTx(accountId, amountUsd, actor.sender);
      const result = await settle(tx, actor.sender);
      return NextResponse.json({ ...result, op, accountId, amountUsd: actualUsd });
    }

    return NextResponse.json({ error: "op must be create | link | deposit | withdraw" }, { status: 400 });
  } catch (err) {
    const msg = (err as Error).message ?? "failed";
    console.warn(`[perp/account] op=${op} failed: ${msg}`);
    return NextResponse.json({ error: friendlyPerpError(msg), raw: msg }, { status: 500 });
  }
}
