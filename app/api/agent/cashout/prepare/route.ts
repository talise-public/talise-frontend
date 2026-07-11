import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { db, ensureSchema, userById } from "@/lib/db";
import {
  createOrder,
  linqConfigured,
  checkDailyOfframpCap,
  cashoutFeatureOpen,
  CASHOUT_CLOSED_MESSAGE,
  isUsdsuiCoinType,
} from "@/lib/linq";
import { resolveLinqBank } from "@/lib/linq-banks";
import { getPrimaryBankAccount, last4 } from "@/lib/bank-accounts";

export const runtime = "nodejs";

/**
 * POST /api/agent/cashout/prepare — chat-driven cash-out to the user's LINKED
 * primary bank. Body: { amountUsd }.
 *
 * Mirrors /api/offramp/linq/create, but the bank details come from the user's
 * saved primary account (decrypted server-side) so they're never sent to the
 * client. Creates a Linq order + returns the deposit wallet; the agent executor
 * then signs a normal sponsored send of `amountUsdsui` to that wallet, and Linq
 * pays the bank. Gated on the feature flag, a linked bank, and the $200/day cap.
 */
export async function POST(req: Request) {
  if (!cashoutFeatureOpen()) {
    return NextResponse.json({ error: CASHOUT_CLOSED_MESSAGE, code: "CASHOUT_CLOSED" }, { status: 503 });
  }
  if (!linqConfigured()) {
    return NextResponse.json({ error: "off-ramp not configured" }, { status: 503 });
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;

  const rl = await rateLimitAsync({ key: `agent-cashout:user:${userId}`, limit: 6, windowSec: 60 });
  if (!rl.ok) {
    return NextResponse.json({ error: "Too many attempts. Try again shortly." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } });
  }

  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  let body: { amountUsd?: number };
  try { body = (await req.json()) as typeof body; } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const amountUsd = Number(body.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return NextResponse.json({ error: "amountUsd must be positive" }, { status: 400 });
  }

  // The bank comes from the user's saved primary account, never the client.
  const bank = await getPrimaryBankAccount(userId);
  if (!bank) {
    return NextResponse.json({ error: "No linked bank account.", code: "NO_BANK" }, { status: 409 });
  }
  const bankMeta = resolveLinqBank(bank.bank_code);
  const accountNumber = String(bank.account_number).trim();
  const accountName = String(bank.account_name ?? "").trim();
  if (!bankMeta || !/^\d{10}$/.test(accountNumber) || !accountName) {
    return NextResponse.json({ error: "Your linked bank looks incomplete. Re-link it in Ramps." }, { status: 409 });
  }

  const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const initialUsdsui = r6(amountUsd);

  const cap = await checkDailyOfframpCap(userId, initialUsdsui);
  if (!cap.ok) {
    return NextResponse.json({ error: cap.error, code: cap.code, remainingToday: cap.remaining }, { status: 400 });
  }

  const id = randomUUID();
  const now = Date.now();

  let order;
  try {
    order = await createOrder({
      amountStableCoin: initialUsdsui,
      bankAccount: accountNumber,
      bankCode: bank.bank_code,
      bankName: bankMeta.name,
      accountName,
      refundAddress: user.sui_address,
      customerRef: String(userId),
      idempotencyKey: id,
    });
  } catch (e) {
    const reason = (e as Error).message ?? "Linq rejected the order";
    console.warn("[agent/cashout] createOrder failed:", reason);
    return NextResponse.json({ error: "Could not start the cash-out.", reason }, { status: 502 });
  }

  if (!isUsdsuiCoinType(order.coinType)) {
    return NextResponse.json({ error: "Could not start the cash-out.", reason: "coin mismatch" }, { status: 502 });
  }

  const lockedRate = order.rate > 0 ? order.rate : (order.amountNGN / Math.max(initialUsdsui, 1e-6));
  const sendUsdsui = r6(order.amountStableCoin > 0 ? order.amountStableCoin : initialUsdsui);
  const creditNgn = r2(order.amountNGN > 0 ? order.amountNGN : sendUsdsui * lockedRate);

  await ensureSchema();
  try {
    await db().execute({
      sql: `INSERT INTO linq_offramps
        (id, linq_order_id, user_id, amount_usdsui, amount_ngn, rate,
         bank_code, bank_account_number, bank_account_name,
         wallet_address, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'initiated', ?, ?)`,
      args: [id, order.id, String(userId), sendUsdsui, creditNgn, lockedRate, bank.bank_code, accountNumber, accountName, order.walletAddress, now, now],
    });
  } catch (e) {
    // FAIL CLOSED (mirrors /api/offramp/linq/create): the Linq order exists but
    // we could not record it. Returning the deposit wallet anyway would let the
    // user fund an order we cannot reconcile, refund, or cap. Refuse — no funds
    // have moved, and the orphaned Linq order (logged) can be cancelled ops-side.
    console.error(
      `[agent/cashout] persist failed — refusing to return deposit wallet. Orphaned Linq order=${order.id} user=${userId}:`,
      (e as Error).message
    );
    return NextResponse.json(
      { error: "Could not record your cash-out. No funds were moved — please try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    orderId: id,
    walletAddress: order.walletAddress,
    amountUsdsui: sendUsdsui,
    amountNgn: creditNgn,
    bankLast4: last4(accountNumber),
  });
}
