import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";

import { userById } from "@/lib/db";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { linqConfigured, cashoutFeatureOpen, CASHOUT_CLOSED_MESSAGE } from "@/lib/linq";
import { resolveLinqBank } from "@/lib/linq-banks";
import { beginLinqOrder, readIdempotencyKey } from "@/lib/offramp/linq-orders";
import { trackCashoutStarted } from "@/lib/analytics/emit";

export const runtime = "nodejs";

/**
 * POST /api/offramp/linq/create
 *
 * Create a Linq off-ramp ORDER. Linq returns a deposit `walletAddress` it
 * watches; the client then sends exactly `amountUsdsui` USDSUI to that address
 * using the normal sponsored send rail, and Linq pays the bank itself.
 *
 * The order-creation sequence (cap → idempotency claim → provider call → coin
 * guard → fail-closed persist → ledger) lives in `lib/offramp/linq-orders.ts` so
 * this route and `/to-user` cannot drift apart again; they previously had
 * different failure behaviour for the same failure.
 *
 * IDEMPOTENCY: send an `Idempotency-Key` header (or `idempotencyKey` in the
 * body) and a retry after a timeout replays the ORIGINAL order rather than
 * creating a second one with a second deposit address.
 *
 * Body: { amountNgn | amountUsdsui, bankCode, accountNumber, accountName, bankName?, idempotencyKey? }
 */
export async function POST(req: Request) {
  // Product gate (FEATURE_CASHOUT), FAILS CLOSED. Refuse BEFORE creating any
  // order so no deposit address is issued and no user is debited.
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
    idempotencyKey?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const bankCode = String(body.bankCode ?? "").trim();
  const accountNumber = String(body.accountNumber ?? "").trim();
  const accountName = String(body.accountName ?? "").trim();
  const bank = resolveLinqBank(bankCode);
  const bankName = String(body.bankName ?? bank?.name ?? "").trim();

  if (!bank || !/^\d{10}$/.test(accountNumber) || !accountName) {
    return NextResponse.json(
      { error: "bankCode, 10-digit accountNumber and accountName are required" },
      { status: 400 }
    );
  }

  const result = await beginLinqOrder({
    userId,
    // The user sends the deposit from their own wallet, so refund there if the
    // bank payout fails, no stuck funds, no manual support needed.
    senderAddress: user.sui_address,
    amountNgn: Number(body.amountNgn),
    amountUsdsui: Number(body.amountUsdsui),
    bankCode,
    bankName,
    accountNumber,
    accountName,
    clientIdempotencyKey: readIdempotencyKey(req, body),
    source: "linq/create",
  });
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  // GROWTH: a real Linq order now exists with a deposit address, so the cash-out
  // funnel started. Skipped on a REPLAYED idempotent retry — that is the same
  // order answered twice, not a second cash-out. The terminal outcome is emitted
  // from the provider webhook; bank coordinates never reach analytics.
  if (!result.replayed) {
    trackCashoutStarted(userId, {
      usd: result.amountUsdsui,
      corridor: "NGN",
      provider: "linq",
    });
  }

  return NextResponse.json({
    orderId: result.orderId,
    linqOrderId: result.linqOrderId,
    walletAddress: result.walletAddress,
    coinType: result.coinType,
    // EXACT amount to debit: send this and the user is credited `amountNgn`.
    amountUsdsui: result.amountUsdsui,
    amountNgn: result.amountNgn,
    rate: result.rate,
    // The client now sends exactly `amountUsdsui` USDSUI to `walletAddress`
    // (normal sponsored send), then POSTs the digest to
    // /api/offramp/linq/deposit and polls /api/offramp/linq/status/[orderId].
    depositWindowMinutes: result.depositWindowMinutes,
    replayed: result.replayed,
  });
}
