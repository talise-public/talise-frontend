import { NextResponse } from "next/server";
import { rateLimitAsync } from "@/lib/rate-limit";
import { settleInvoiceByDigest } from "@/lib/invoices";
import { suiscanTxUrl } from "@/lib/sui";

export const runtime = "nodejs";

/**
 * POST /api/invoices/[id]/settle, TRUSTLESS public settlement of a rich
 * (`work_invoices`) invoice.
 *
 * Anyone (the payer, NO auth required) can close an open invoice by submitting
 * the on-chain digest of their payment. The server never trusts the caller: it
 * loads the invoice + issuer authoritatively, fetches the transaction by digest
 * via the canonical verifier, and only marks the invoice paid when the tx
 * SUCCEEDED and credited the issuer's address with at least the invoice's
 * canonical USDsui amount.
 *
 * The verify-and-close core lives in `settleInvoiceByDigest` (web/lib/invoices)
 * and is shared with the owner's "mark paid" action so both paths give the same
 * replay/amount guarantees. This route is the public, full-amount-bound caller.
 *
 * Idempotent: re-settling an already-paid invoice returns ok with the recorded
 * digest. Replay-guarded: a digest that already settled a different invoice is
 * rejected (so one payment can't clear two same-amount invoices to a merchant).
 */

const DIGEST_RE = /^[1-9A-HJ-NP-Za-km-z]{40,60}$/;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: { digest?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const digest = typeof body.digest === "string" ? body.digest.trim() : "";
  if (!DIGEST_RE.test(digest)) {
    return NextResponse.json(
      { error: "a valid transaction digest is required" },
      { status: 400 }
    );
  }

  // Per-invoice rate limit, settlement does an RPC round-trip, so cap retries.
  const rl = await rateLimitAsync({
    key: `invoice-settle:${id}`,
    limit: 30,
    windowSec: 600,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 600) } }
    );
  }

  const result = await settleInvoiceByDigest(id, digest);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    ok: true,
    status: "paid",
    digest: result.digest,
    explorerUrl: suiscanTxUrl(result.digest),
  });
}
