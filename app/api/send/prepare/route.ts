import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { sui, COIN_TYPES, USDSUI_DECIMALS } from "@/lib/sui";
import { USDSUI_TYPE } from "@/lib/usdsui";
import { appendPaymentKitReceipt } from "@/lib/intents/wrap-payment-kit";
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
  // Private-beta guardrail: signed-in is not enough, the account must be on
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

  // ── Compliance screening, HARD STOP (mirrors /api/send/sponsor-prepare) ──
  // This legacy build path mints signable bytes too, so it MUST run the same
  // screen before producing them, otherwise it's a screening bypass. Runs
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

  // ── Rolling transaction-limit gate (USDsui only, the cap engine is
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
      //   2. Every Talise send is provably part of the platform -
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

      // ── NO Spend + Save leg on this route ───────────────────────────
      // This endpoint returns TRANSACTION-KIND bytes, which `/api/zk/sponsor`
      // then wraps into full TransactionData. That means the digest is not
      // known here, and the digest is exactly what the save proof has to be
      // bound to (lib/rewards/roundup.ts): without it there is no way to
      // credit the savings tally against the transaction that actually
      // carried the save. Appending a supply leg we could never prove is how
      // the tally came to rise with no money behind it in the first place.
      //
      // Spend + Save therefore lives ONLY on `/api/send/sponsor-prepare`,
      // which builds the full sponsor-ready bytes itself and so can mint a
      // digest-bound proof. Clients that want round-up must use that route;
      // this one stays a plain transfer builder for the legacy Earn/vault
      // flows that still need the prepare→sponsor split.

      const kind = await tx.build({
        client: sui() as never,
        onlyTransactionKind: true,
      });

      // Reserve against the rolling limit window (USDsui only; best-effort -
      // recordSend never throws, mirrors sponsor-prepare's reservation model).
      void recordSend({ userId, amountUsd: amountNum, asset, digest: null });

      return NextResponse.json({
        transactionKindB64: toBase64(kind),
        asset,
        amount: amountNum,
        to,
        receiptNonce: nonce,
        // DEPRECATED, always 0. Spend + Save is not available on this route
        // (see above) and a non-zero value here would make a pre-atomic
        // client fire a second, standalone save transaction.
        roundupUsd: 0,
      });
    }

    // SUI transfers can't use Payment Kit (the registry is USDsui-only
    //, coinType is fixed at registry creation time). Keep the existing
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
