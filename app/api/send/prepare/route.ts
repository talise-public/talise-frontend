import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { sui, COIN_TYPES, USDSUI_DECIMALS } from "@/lib/sui";
import { USDSUI_TYPE } from "@/lib/usdsui";
import { appendPaymentKitReceipt } from "@/lib/intents/wrap-payment-kit";
import { getRoundupConfig } from "@/lib/rewards/roundup";
import { appendNaviSupply, SAVE_TREASURY_FEE_BPS } from "@/lib/navi-supply";
import { checkSendAllowed, recordSend } from "@/lib/send-limits";
import { screenTransfer } from "@/lib/screening";

export const runtime = "nodejs";

/**
 * POST /api/send/build
 *
 * Server-side PTB construction for iOS. Web builds PTBs inline via
 * @mysten/sui; mobile hands us { to, amount, asset } and we return the
 * `transactionKindB64` ready to feed into /api/zk/sponsor.
 *
 * Why server-side: bundling SuiKit's full PTB builder in the iOS app is
 * a multi-day port we can defer. The kind bytes are deterministic and
 * cheap to produce here.
 */

const SUPPORTED_ASSETS = new Set(["USDsui", "SUI"]);
const ADDRESS_RE = /^0x[a-f0-9]{64}$/i;

export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // Private-beta guardrail: signed-in is not enough — the account must be on
  // the app allowlist before it can originate any value-moving call.
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: { to?: string; amount?: number | string; asset?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const to = (body.to ?? "").trim().toLowerCase();
  if (!ADDRESS_RE.test(to)) {
    return NextResponse.json(
      { error: "recipient must be a 0x-prefixed Sui address" },
      { status: 400 }
    );
  }
  if (to === user.sui_address.toLowerCase()) {
    return NextResponse.json(
      { error: "you can't send to your own wallet" },
      { status: 400 }
    );
  }

  const asset = body.asset ?? "USDsui";
  if (!SUPPORTED_ASSETS.has(asset)) {
    return NextResponse.json(
      { error: `asset must be one of ${[...SUPPORTED_ASSETS].join(", ")}` },
      { status: 400 }
    );
  }

  const amountNum = Number(body.amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return NextResponse.json(
      { error: "amount must be a positive number" },
      { status: 400 }
    );
  }

  const decimals = asset === "USDsui" ? USDSUI_DECIMALS : 9;
  const onchain = BigInt(Math.round(amountNum * 10 ** decimals));
  if (onchain <= 0n) {
    return NextResponse.json({ error: "amount too small" }, { status: 400 });
  }

  // ── Compliance screening — HARD STOP (mirrors /api/send/sponsor-prepare) ──
  // This legacy build path mints signable bytes too, so it MUST run the same
  // screen before producing them — otherwise it's a screening bypass. Runs
  // AFTER recipient/amount validation, BEFORE any PTB bytes are built.
  // `screenTransfer` is fail-closed on a sanctioned-name hit, fail-open on a
  // provider/transport error (a vendor outage must not 500 every send).
  const screen = await screenTransfer({
    senderAddr: user.sui_address,
    recipientAddr: to,
    senderName: user.business_name ?? user.name,
    recipientName: null,
  });
  if (!screen.allow) {
    console.warn(
      `[send/prepare] SCREENING_BLOCK user=${userId} to=${to} cause=${screen.cause} reason=${screen.reason}`
    );
    return NextResponse.json(
      {
        error: "This transfer was blocked by a compliance screen.",
        code: "SCREENING_BLOCK",
        reason: screen.reason,
      },
      { status: 403 }
    );
  }

  // ── Rolling transaction-limit gate (USDsui only — the cap engine is
  // fiat-USD; USDsui is 1:1 USD). Fail-open by contract. ────────────────────
  if (asset === "USDsui") {
    const decision = await checkSendAllowed(userId, amountNum);
    if (!decision.allowed) {
      console.warn(
        `[send/prepare] LIMIT_EXCEEDED user=${userId} tier=${decision.tier} ` +
          `window=${decision.window} amount=${amountNum} used=${decision.used} limit=${decision.limit}`
      );
      return NextResponse.json(
        {
          error: `This send would exceed your ${decision.window} limit of $${decision.limit.toLocaleString()}. You've sent $${decision.used.toLocaleString()} in this window.`,
          code: "LIMIT_EXCEEDED",
          window: decision.window,
          limit: decision.limit,
          used: decision.used,
        },
        { status: 403 }
      );
    }
  }

  try {
    const tx = new Transaction();
    tx.setSender(user.sui_address);

    if (asset === "USDsui") {
      // Wrap the send in a Payment Kit `processRegistryPayment` call.
      // PK pulls USDsui from the sender via `coinWithBalance` (Address
      // Balance compatible) and transfers to the receiver in a single
      // MoveCall, while minting a PaymentRecord under the `talise`
      // global registry with a typed memo in the nonce. Three wins
      // vs the old `coinWithBalance + transferObjects` form:
      //   1. The PK call IS a MoveCall, so we no longer need the
      //      `0x2::clock::timestamp_ms` no-op shim to satisfy Onara's
      //      "≥1 MoveCall" sponsor policy.
      //   2. Every Talise send is provably part of the platform —
      //      Suiscan shows the PK call as the tx kind, and indexers
      //      can recover the kind ("send"), sender, receiver, and
      //      timestamp from the nonce alone.
      //   3. Audit narrative: receipts queryable by digest →
      //      PaymentRecord. Important for the hackathon's security
      //      sponsors (OpenZeppelin / OtterSec).
      const { nonce } = appendPaymentKitReceipt(tx, {
        kind: "send",
        sender: user.sui_address,
        receiver: to,
        amountUsdsui: amountNum,
      });

      // Round-up & Save (Phase 2 v2 — real on-chain auto-supply).
      // If the user has toggled round-up on, we append a NAVI supply
      // for `amount × percentage / 100` USDsui to the SAME PTB so the
      // send + the save land atomically in one user-signed tx. No
      // delegation key needed — the user signs once for both legs.
      // If the supply leg fails on chain (insufficient balance after
      // the send), the WHOLE tx fails — the user sees a clean error
      // rather than a half-applied state.
      let roundupUsd = 0;
      try {
        const cfg = await getRoundupConfig(userId);
        // Diagnostic — surfaces in the dev log so we can tell at a
        // glance whether the toggle was read correctly + what the
        // computed amount worked out to. Critical for debugging
        // "I turned it on but nothing happened" reports.
        console.log(
          `[send/prepare] roundup config: enabled=${cfg.enabled} pct=${cfg.percentage}`
        );
        if (cfg.enabled && cfg.percentage > 0) {
          const computed = (amountNum * cfg.percentage) / 100;
          // Floor at "any positive on-chain integer" rather than a
          // dollar threshold. A user sending ₦50 at 2% gets ₦1 of
          // round-up = $0.0007 USDsui = 700 micro-USDsui, which is
          // a perfectly valid on-chain supply (NAVI accepts any
          // positive amount). Earlier revision used a $0.01 floor
          // that silently swallowed every small-NGN test — exactly
          // the case the user reported.
          const cappedUsd = Math.min(computed, amountNum);
          const microUnits = Math.round(cappedUsd * 1e6);
          if (microUnits > 0) {
            roundupUsd = cappedUsd;
            await appendNaviSupply(tx, user.sui_address, roundupUsd, { treasuryFeeBps: SAVE_TREASURY_FEE_BPS });
            // Tag the supply leg with a Payment Kit marker so the
            // activity classifier + rewards engine recognize it as
            // a round-up (not a manual invest). Same digest, second
            // PaymentRecord under the talise registry.
            appendPaymentKitReceipt(tx, {
              kind: "invest",
              sender: user.sui_address,
              refs: { venue: "navi" },
            });
            console.log(
              `[send/prepare] roundup APPENDED: $${roundupUsd.toFixed(6)} USDsui (${microUnits} micro-units)`
            );
          } else {
            console.log(
              `[send/prepare] roundup skipped: computed $${computed.toFixed(8)} rounds to 0 micro-units`
            );
          }
        }
      } catch (err) {
        // Defensive — a round-up build failure must NOT block the
        // send. If we can't compose the supply leg (NAVI SDK init
        // failure, etc.), fall back to a send-only PTB.
        console.warn(
          "[send/prepare] round-up append failed, falling back to send-only:",
          (err as Error).message
        );
        roundupUsd = 0;
      }

      const kind = await tx.build({
        client: sui() as never,
        onlyTransactionKind: true,
      });

      // Reserve against the rolling limit window (USDsui only; best-effort —
      // recordSend never throws, mirrors sponsor-prepare's reservation model).
      void recordSend({ userId, amountUsd: amountNum, asset, digest: null });

      return NextResponse.json({
        transactionKindB64: toBase64(kind),
        asset,
        amount: amountNum,
        to,
        receiptNonce: nonce,
        // Server-blessed round-up amount, in USDsui. iOS forwards
        // this to /api/zk/sponsor-execute as `meta.roundupUsd` so
        // the rewards engine credits both legs (send points + 5
        // pts/$1 for the round-up). 0 when round-up didn't fire.
        roundupUsd,
      });
    }

    // SUI transfers can't use Payment Kit (the registry is USDsui-only
    // — coinType is fixed at registry creation time). Keep the existing
    // clock-MoveCall + split + transfer path for raw SUI sends.
    tx.moveCall({
      target: "0x2::clock::timestamp_ms",
      arguments: [tx.object("0x6")],
    });
    const coinType = COIN_TYPES.SUI;
    const out = tx.add(
      coinWithBalance({ type: coinType, balance: onchain, useGasCoin: false })
    );
    tx.transferObjects([out], to);

    const kind = await tx.build({
      client: sui() as never,
      onlyTransactionKind: true,
    });

    return NextResponse.json({
      transactionKindB64: toBase64(kind),
      asset,
      amount: amountNum,
      to,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "build failed: " + (err as Error).message },
      { status: 500 }
    );
  }
}
