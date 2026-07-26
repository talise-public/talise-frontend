import { NextResponse } from "next/server";

import { db, ensureSchema } from "@/lib/db";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { markAttemptFunded, recordAttempt } from "@/lib/offramp/store";

export const runtime = "nodejs";

/**
 * POST /api/offramp/linq/deposit
 *
 * Record the on-chain digest of the deposit the client just sent to the
 * provider's watched wallet. Body: { orderId, digest }.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 * -----------------------------------
 * The Linq rail is deposit-address based: the user's on-chain send IS the debit,
 * and it goes to an address Talise does not control. Nothing in the system
 * recorded whether that send ever happened. So after a provider failure we could
 * not answer the only question that matters:
 *
 *     "Did this user actually part with their money?"
 *
 * Without that fact, a failed payout is indistinguishable from an abandoned one.
 * The reconciler needs it to decide between EXPIRING an order (never funded,
 * free the user's daily cap) and flagging it STRANDED (funded, refund owed).
 * That distinction is exactly what was missing during the "500s with no
 * auto-refund" incident.
 *
 * This endpoint records EVIDENCE, it does not grant anything: the digest is
 * stored as a claim by the authenticated owner of the order. It is intentionally
 * not on-chain-verified here (verification belongs with the sponsored-send
 * confirm path, which already has the transaction in hand); an unverifiable
 * digest still tells reconciliation and support that the user believes they
 * funded it, which is strictly better than silence.
 */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const rl = await rateLimitAsync({
    key: `offramp-linq-deposit:user:${userId}`,
    limit: 30,
    windowSec: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } }
    );
  }

  let body: { orderId?: string; digest?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const orderId = String(body.orderId ?? "").trim();
  const digest = String(body.digest ?? "").trim();
  if (!orderId || !digest || digest.length > 100 || !/^[A-Za-z0-9]+$/.test(digest)) {
    return NextResponse.json({ error: "orderId and a valid digest are required" }, { status: 400 });
  }

  await ensureSchema();
  const r = await db().execute({
    sql: `SELECT id, linq_order_id, user_id, amount_usdsui, amount_ngn, wallet_address
            FROM linq_offramps WHERE id = ? LIMIT 1`,
    args: [orderId],
  });
  const row = r.rows[0];
  if (!row) return NextResponse.json({ error: "order not found" }, { status: 404 });
  if (String(row.user_id) !== String(userId)) {
    // Ownership check: only the account that owns the cash-out can attest to
    // funding it.
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // The attempt row normally already exists (created with the order); recreate it
  // defensively so evidence is never dropped because the ledger write raced.
  try {
    await recordAttempt({
      id: String(row.id),
      userId,
      provider: "linq",
      corridor: "NGN",
      usdAmount: Number(row.amount_usdsui),
      destAmount: Number(row.amount_ngn),
      providerRef: String(row.linq_order_id),
      depositAddress: (row.wallet_address as string | null) ?? undefined,
      state: "funded",
    });
  } catch {
    /* already present, fine */
  }
  await markAttemptFunded(String(row.id), digest);

  console.log(
    `[offramp/linq/deposit] user=${userId} row=${row.id} order=${row.linq_order_id} funded digest=${digest}`
  );
  return NextResponse.json({ ok: true, orderId, funded: true });
}
