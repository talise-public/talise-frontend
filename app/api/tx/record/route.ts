import { NextResponse } from "next/server";
import { readSessionEntryId } from "@/lib/session";
import {
  invoiceBySlug,
  markInvoicePaid,
  recordTx,
  setInvoiceReceiptObjectId,
  userById,
} from "@/lib/db";
import { getNormalizedTransaction } from "@/lib/sui-shapes";
import { isUsdsui } from "@/lib/usdsui";
import { requireAppAttestStructural } from "@/lib/app-attest";

export const runtime = "nodejs";

/**
 * POST /api/tx/record
 *
 * Records an outbound transaction in the user's history table after they've
 * signed and broadcast it. The caller controls the body fully, so every
 * field is validated + length-capped before it hits the DB. tx_history is a
 * hint/cache, for audit-grade truth we read chain directly via lib/activity.
 */

// Sui tx digest: base58 of a 32-byte hash. ~44 chars typical. We allow 40-60.
const DIGEST_RE = /^[1-9A-HJ-NP-Za-km-z]{40,60}$/;
const KIND_ALLOWED = new Set([
  "send",
  "pay-merchant",
  "pay-invoice",
  "payroll",
  "bills",
  "remit",
  "earn-supply",
  "spot-lp-deposit",
  "send-cross-asset",
  "send-and-invest",
]);
const ASSET_ALLOWED = new Set([
  "USDsui",
  "SUI",
  "USDC",
  "USDsui→SUI",
  "SUI→USDsui",
]);
const ADDR_RE = /^0x[a-fA-F0-9]{64}$/;
const SLUG_RE = /^[a-z0-9_-]{1,64}$/;
const MEMO_MAX = 200;
const AMOUNT_MAX = 64;

export async function POST(req: Request) {
  // P1-5: mobile traffic must carry an App Attest assertion.
  const attestBlock = requireAppAttestStructural(req);
  if (attestBlock) return attestBlock;

  const userId = await readSessionEntryId();
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: {
    digest?: unknown;
    kind?: unknown;
    amount?: unknown;
    asset?: unknown;
    recipient?: unknown;
    memo?: unknown;
    invoiceSlug?: unknown;
    receiptObjectId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  if (typeof body.digest !== "string" || !DIGEST_RE.test(body.digest)) {
    return NextResponse.json(
      { error: "digest required (40-60 base58 chars)" },
      { status: 400 }
    );
  }
  const digest = body.digest;

  const kindRaw = typeof body.kind === "string" ? body.kind : "send";
  const kind = KIND_ALLOWED.has(kindRaw) ? kindRaw : "send";

  let amount: string | null = null;
  if (typeof body.amount === "string" && body.amount.length > 0) {
    if (body.amount.length > AMOUNT_MAX) {
      return NextResponse.json({ error: "amount too long" }, { status: 400 });
    }
    if (!/^-?\d+(\.\d+)?$/.test(body.amount)) {
      return NextResponse.json(
        { error: "amount must be numeric" },
        { status: 400 }
      );
    }
    amount = body.amount;
  }

  const asset =
    typeof body.asset === "string" && ASSET_ALLOWED.has(body.asset)
      ? body.asset
      : null;

  let recipient: string | null = null;
  if (typeof body.recipient === "string" && body.recipient.length > 0) {
    if (!ADDR_RE.test(body.recipient)) {
      return NextResponse.json(
        { error: "recipient must be 0x + 64 hex chars" },
        { status: 400 }
      );
    }
    recipient = body.recipient.toLowerCase();
  }

  let memo: string | null = null;
  if (typeof body.memo === "string" && body.memo.length > 0) {
    memo = body.memo.slice(0, MEMO_MAX);
  }

  let invoiceSlug: string | null = null;
  if (typeof body.invoiceSlug === "string" && body.invoiceSlug.length > 0) {
    if (!SLUG_RE.test(body.invoiceSlug)) {
      return NextResponse.json(
        { error: "invoiceSlug must be 1-64 [a-z0-9_-] chars" },
        { status: 400 }
      );
    }
    invoiceSlug = body.invoiceSlug;
  }

  let receiptObjectId: string | null = null;
  if (
    typeof body.receiptObjectId === "string" &&
    body.receiptObjectId.length > 0
  ) {
    if (!ADDR_RE.test(body.receiptObjectId)) {
      return NextResponse.json(
        { error: "receiptObjectId must be 0x + 64 hex chars" },
        { status: 400 }
      );
    }
    receiptObjectId = body.receiptObjectId.toLowerCase();
  }

  await recordTx({
    userId: user.id,
    digest,
    kind,
    amount,
    asset,
    recipient,
    memo,
    receiptObjectId,
  });

  // TODO(rewards): wire volume-milestone + first-send bonuses here once we
  // settle on a USDsui amount normalization. The helpers live in
  // `lib/rewards.ts`, `awardVolumePoints(user.id, amountUsdsui, digest)` for
  // every send, and `awardFirstSendBonus(user.id, digest)` gated by a
  // `tx_history` row-count check so it only fires once per user.

  if (invoiceSlug) {
    // P1-3: never trust client-submitted amount / recipient for
    // invoice payments. Load the invoice authoritatively, then
    // verify on-chain that the submitted digest paid the merchant
    // the exact canonical amount in USDsui.
    const result = await verifyAndCloseInvoice({
      slug: invoiceSlug,
      digest,
      payerAddress: user.sui_address,
      receiptObjectId,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: `invoice verification failed: ${result.reason}` },
        { status: 400 }
      );
    }
  }

  return NextResponse.json({ ok: true });
}

// ─── Invoice verification ────────────────────────────────────────────────

const USDSUI_MICRO_DIVISOR = 1_000_000;

type VerifyResult = { ok: true } | { ok: false; reason: string };

async function verifyAndCloseInvoice(input: {
  slug: string;
  digest: string;
  payerAddress: string;
  receiptObjectId: string | null;
}): Promise<VerifyResult> {
  const invoice = await invoiceBySlug(input.slug);
  if (!invoice) return { ok: false, reason: "invoice not found" };
  if (invoice.status !== "open") {
    // Already paid (or void). Idempotent: don't error, but don't
    // overwrite the prior digest either.
    return { ok: true };
  }

  const merchant = await userById(invoice.business_user_id);
  if (!merchant) return { ok: false, reason: "merchant not found" };
  const merchantAddress = merchant.sui_address.toLowerCase();

  const expectedUsdsui = Number(invoice.amount_usdc);
  if (!Number.isFinite(expectedUsdsui) || expectedUsdsui <= 0) {
    return { ok: false, reason: "invoice amount invalid" };
  }
  // Tolerance for u64<>float rounding (1e-6 USDsui = 1 micro-unit).
  const expectedMicro = BigInt(Math.round(expectedUsdsui * USDSUI_MICRO_DIVISOR));

  let tx;
  try {
    tx = await getNormalizedTransaction(input.digest);
  } catch (e) {
    // Keep the internal detail server-side; return a generic client reason so
    // raw RPC/exception messages don't leak into the API response.
    console.error(
      `[tx/record] tx fetch failed for digest=${input.digest}: ${(e as Error).message}`
    );
    return { ok: false, reason: "verification unavailable, try again" };
  }

  if (tx.status !== "success") {
    return { ok: false, reason: `tx status is ${tx.status}` };
  }

  // Walk balanceChanges: the merchant address must end with a
  // USDsui positive delta >= invoice canonical amount.
  let merchantReceivedMicro = 0n;
  for (const c of tx.balanceChanges) {
    if (c.ownerAddress !== merchantAddress) continue;
    if (!isUsdsui(c.coinType)) continue;
    // amount is a signed bigint (raw u64 minor units), already parsed by the normalizer.
    if (c.amount > 0n) merchantReceivedMicro += c.amount;
  }

  if (merchantReceivedMicro < expectedMicro) {
    return {
      ok: false,
      reason: `recipient received ${merchantReceivedMicro} micro USDsui, expected >= ${expectedMicro}`,
    };
  }

  try {
    await markInvoicePaid(input.slug, input.digest, input.payerAddress);
    if (input.receiptObjectId) {
      await setInvoiceReceiptObjectId(input.slug, input.receiptObjectId);
    }
  } catch (e) {
    // Keep the internal detail server-side; return a generic client reason.
    console.error(
      `[tx/record] markInvoicePaid failed for slug=${input.slug}: ${(e as Error).message}`
    );
    return { ok: false, reason: "verification unavailable, try again" };
  }
  return { ok: true };
}
