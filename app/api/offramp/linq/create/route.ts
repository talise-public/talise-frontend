import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { randomUUID } from "node:crypto";

import { db, ensureSchema, userById } from "@/lib/db";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { createOrder, getRate, linqConfigured, checkDailyOfframpCap, cashoutFeatureOpen, CASHOUT_CLOSED_MESSAGE, isUsdsuiCoinType } from "@/lib/linq";
import { resolveLinqBank } from "@/lib/linq-banks";

export const runtime = "nodejs";

/**
 * POST /api/offramp/linq/create
 *
 * Create a Linq off-ramp ORDER. Linq returns a deposit `walletAddress` it
 * watches; the client then sends exactly `amountUsdsui` USDSUI to that address
 * using the normal sponsored send rail, and Linq pays the bank itself.
 *
 * We persist a `linq_offramps` row keyed to the user and return the deposit
 * address + locked NGN. No treasury, no on-chain verification, no refund path
 * (Linq owns deposit detection + the 10-minute timeout).
 *
 * Body: { amountUsdsui, bankCode, accountNumber, accountName, bankName? }
 */
export async function POST(req: Request) {
  // Product gate (FEATURE_CASHOUT), closed for launch. Refuse BEFORE creating
  // any order so no deposit address is issued and no user is debited.
  if (!cashoutFeatureOpen()) {
    return NextResponse.json({ error: CASHOUT_CLOSED_MESSAGE, code: "CASHOUT_CLOSED" }, { status: 503 });
  }
  if (!linqConfigured()) {
    return NextResponse.json({ error: "off-ramp not configured" }, { status: 503 });
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // Private-beta guardrail: signed-in is not enough, the account must be on
  // the app allowlist before it can originate any value-moving call.
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  // Tighter cap on order creation than on quoting, each creates a real Linq
  // order. Defense-in-depth on top of Linq's own 10/min/key limit.
  const rl = await rateLimitAsync({ key: `offramp-linq-create:user:${userId}`, limit: 6, windowSec: 60 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } }
    );
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: {
    /** Cash-out denominated in NGN, the user is credited exactly this. */
    amountNgn?: number;
    /** Or denominated in USDsui (the amount debited). One of the two. */
    amountUsdsui?: number;
    bankCode?: string;
    accountNumber?: string;
    accountName?: string;
    bankName?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const reqNgn = Number(body.amountNgn);
  const reqUsdsui = Number(body.amountUsdsui);
  const wantsNgn = Number.isFinite(reqNgn) && reqNgn > 0;
  const wantsUsdsui = Number.isFinite(reqUsdsui) && reqUsdsui > 0;
  const bankCode = String(body.bankCode ?? "").trim();
  const accountNumber = String(body.accountNumber ?? "").trim();
  const accountName = String(body.accountName ?? "").trim();
  const bank = resolveLinqBank(bankCode);
  const bankName = String(body.bankName ?? bank?.name ?? "").trim();

  if (!wantsNgn && !wantsUsdsui) {
    return NextResponse.json(
      { error: "amountNgn or amountUsdsui must be positive" },
      { status: 400 }
    );
  }
  if (!bank || !/^\d{10}$/.test(accountNumber) || !accountName) {
    return NextResponse.json(
      { error: "bankCode, 10-digit accountNumber and accountName are required" },
      { status: 400 }
    );
  }

  const r6 = (n: number) => Math.round(n * 1e6) / 1e6; // USDsui = 6 dp
  const r2 = (n: number) => Math.round(n * 100) / 100; // NGN = 2 dp

  // Initial amountStableCoin for the order (informational, Linq pays on what
  // actually ARRIVES at the locked rate). For an NGN-denominated cash-out we
  // estimate it from the display rate; we recompute the EXACT amount to send
  // from the order's LOCKED rate below.
  let initialUsdsui = wantsUsdsui ? reqUsdsui : 0;
  if (wantsNgn && !wantsUsdsui) {
    try {
      const rateNow = (await getRate()).rate;
      if (!Number.isFinite(rateNow) || rateNow <= 0) throw new Error("bad rate");
      initialUsdsui = r6(reqNgn / rateNow);
    } catch {
      return NextResponse.json({ error: "rate_unavailable" }, { status: 503 });
    }
  }


  // Per-account DAILY cap: $200/day across all cash-outs (KYC unlocks more).
  const cap = await checkDailyOfframpCap(userId, initialUsdsui);
  if (!cap.ok) {
    return NextResponse.json(
      { error: cap.error, code: cap.code, maxUsd: cap.max, usedToday: cap.used, remainingToday: cap.remaining },
      { status: 400 }
    );
  }

  const id = randomUUID(); // our row id; doubles as the idempotency key
  const now = Date.now();

  let order;
  try {
    order = await createOrder({
      amountStableCoin: initialUsdsui,
      bankAccount: accountNumber,
      bankCode,
      bankName,
      accountName,
      // The user sends the deposit from their own wallet, so refund there if
      // the bank payout fails, no stuck funds, no manual support needed.
      refundAddress: user.sui_address,
      customerRef: String(userId),
      idempotencyKey: id,
    });
  } catch (e) {
    const reason = (e as Error).message ?? "Linq rejected the order";
    console.warn("[offramp/linq/create] createOrder failed:", reason);
    return NextResponse.json({ error: "Could not start the cash-out.", reason }, { status: 502 });
  }

  // Coin guard: never let the client deposit USDSUI into an order Linq is
  // watching for a different coin. We pin coin=usdsui on createOrder, but we
  // also refuse if the echoed coinType isn't our USDSUI.
  if (!isUsdsuiCoinType(order.coinType)) {
    console.warn("[offramp/linq/create] unexpected coinType:", order.coinType);
    return NextResponse.json(
      { error: "Could not start the cash-out.", reason: "off-ramp coin mismatch" },
      { status: 502 }
    );
  }

  // CRITICAL: send EXACTLY what Linq recorded on the order (order.amountStableCoin)
  //, that's the amount its deposit watcher matches. Recomputing our own send
  // figure from the locked rate produced a value that drifted from what Linq
  // expected whenever the rate ticked between quote and create, so the deposit
  // was never recognized → "timeout: no deposit received" → failed payout.
  // We credit order.amountNGN (Linq's own locked computation) to stay consistent.
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
      args: [
        id,
        order.id,
        String(userId),
        sendUsdsui,
        creditNgn,
        lockedRate,
        bankCode,
        accountNumber,
        accountName,
        order.walletAddress,
        now,
        now,
      ],
    });
  } catch (e) {
    // FAIL CLOSED: the Linq order was created but we could not record it. If we
    // still handed the deposit wallet back, the user would send funds to an
    // order we cannot reconcile, refund, or count against the daily cap. Refuse
    // instead, no funds have moved yet, and the orphaned Linq order (logged
    // here with its id) holds no user funds and can be cancelled ops-side.
    console.error(
      `[offramp/linq/create] persist failed, refusing to return deposit wallet. Orphaned Linq order=${order.id} user=${userId}:`,
      (e as Error).message
    );
    return NextResponse.json(
      { error: "Could not record your cash-out. No funds were moved, please try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    orderId: id,
    linqOrderId: order.id,
    walletAddress: order.walletAddress,
    coinType: order.coinType,
    // EXACT amount to debit: send this and the user is credited `amountNgn`.
    amountUsdsui: sendUsdsui,
    amountNgn: creditNgn,
    rate: lockedRate,
    // The client now sends exactly `amountUsdsui` USDSUI to `walletAddress`
    // (normal sponsored send), then polls /api/offramp/linq/status/[orderId].
    depositWindowMinutes: 10,
  });
}
