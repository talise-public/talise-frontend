import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";

import { userById, userBySuiAddress } from "@/lib/db";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { linqConfigured, cashoutFeatureOpen, CASHOUT_CLOSED_MESSAGE } from "@/lib/linq";
import { resolveLinqBank } from "@/lib/linq-banks";
import { resolveRecipient } from "@/lib/suins";
import { getPrimaryBankAccount, last4 } from "@/lib/bank-accounts";
import { beginLinqOrder, readIdempotencyKey } from "@/lib/offramp/linq-orders";

export const runtime = "nodejs";

/**
 * POST /api/offramp/linq/to-user
 *
 * "Pay a @handle straight to their bank." The SENDER picks a recipient and an
 * NGN amount; we resolve the recipient to a Talise user, load THEIR primary
 * payout bank, and create a Linq off-ramp order to that bank. We hand the
 * sender back a deposit `walletAddress` + the EXACT `amountUsdsui` to send. The
 * sender NEVER receives the recipient's full account number, only a masked
 * "<BankName> ••••<last4>".
 *
 * The `linq_offramps` row is keyed to the SENDER's user id (it's the sender's
 * cash-out), with the bank fields set to the RECIPIENT's primary bank.
 *
 * FIXED (money bug): this route used to log-and-continue when it could not
 * persist the order, handing the deposit wallet back anyway. A user who funded
 * that order was invisible, unpollable (no row → 404 from /status), uncapped and
 * unrefundable. It now shares the fail-closed implementation with /create.
 *
 * Body: { recipient: string (@handle or 0x address), amountNgn: number, idempotencyKey? }
 */
export async function POST(req: Request) {
  // Product gate (FEATURE_CASHOUT), FAILS CLOSED.
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
  // Same tight cap as /create, each call creates a real Linq order.
  const rl = await rateLimitAsync({
    key: `offramp-linq-to-user:user:${userId}`,
    limit: 6,
    windowSec: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } }
    );
  }
  const sender = await userById(userId);
  if (!sender) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: { recipient?: string; amountNgn?: number; idempotencyKey?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const recipientInput = String(body.recipient ?? "").trim();
  const reqNgn = Number(body.amountNgn);
  if (!recipientInput) {
    return NextResponse.json({ error: "recipient is required" }, { status: 400 });
  }
  if (!Number.isFinite(reqNgn) || reqNgn <= 0) {
    return NextResponse.json({ error: "amountNgn must be positive" }, { status: 400 });
  }

  // Resolve the recipient → a Talise user → their PRIMARY payout bank.
  let recipientAddress: string;
  try {
    const resolved = await resolveRecipient(recipientInput);
    if (!resolved) {
      return NextResponse.json({ error: "recipient not found" }, { status: 404 });
    }
    recipientAddress = resolved.address;
  } catch (e) {
    console.warn("[offramp/linq/to-user] resolve failed:", (e as Error).message);
    return NextResponse.json({ error: "Could not resolve the recipient." }, { status: 502 });
  }

  const recipient = await userBySuiAddress(recipientAddress);
  if (!recipient) {
    return NextResponse.json({ error: "recipient has no bank on file" }, { status: 404 });
  }
  const bankRow = await getPrimaryBankAccount(recipient.id);
  if (!bankRow) {
    return NextResponse.json({ error: "recipient has no bank on file" }, { status: 404 });
  }

  const bank = resolveLinqBank(bankRow.bank_code);
  const bankName = bank?.name ?? bankRow.bank_code;
  const accountNumber = bankRow.account_number;
  const accountName = bankRow.account_name ?? "";
  if (!/^\d{10}$/.test(accountNumber) || !accountName) {
    // A malformed stored bank shouldn't expose internals to the sender.
    return NextResponse.json({ error: "recipient has no bank on file" }, { status: 404 });
  }

  const result = await beginLinqOrder({
    // Keyed to the SENDER, it's the sender's cash-out (and the sender's cap),
    // even though the bank fields belong to the recipient.
    userId,
    // The SENDER funds the deposit, so a failed payout refunds to the sender,
    // never the recipient (who never sent anything).
    senderAddress: sender.sui_address,
    amountNgn: reqNgn,
    bankCode: bankRow.bank_code,
    bankName,
    accountNumber,
    accountName,
    clientIdempotencyKey: readIdempotencyKey(req, body),
    source: "linq/to-user",
  });
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json({
    orderId: result.orderId,
    walletAddress: result.walletAddress,
    coinType: result.coinType,
    // EXACT amount the SENDER must send so the recipient is credited amountNgn.
    amountUsdsui: result.amountUsdsui,
    amountNgn: result.amountNgn,
    rate: result.rate,
    recipientName: accountName,
    // Masked, the sender sees the bank + last 4 only, never the full number.
    recipientBankLabel: `${bankName} ••••${last4(accountNumber)}`,
    depositWindowMinutes: result.depositWindowMinutes,
    replayed: result.replayed,
  });
}
