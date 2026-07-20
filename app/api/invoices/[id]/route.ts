import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import {
  workInvoiceById,
  voidWorkInvoice,
  settleInvoiceByDigest,
  type WorkInvoice,
} from "@/lib/invoices";

export const runtime = "nodejs";

/**
 * GET /api/invoices/[id]
 *
 * Two views of one invoice, decided by who's asking:
 *   • OWNER (the signed-in issuer): the FULL invoice row (status, payer, etc).
 *   • EVERYONE ELSE (the payer hitting the public /i/<id> page): a
 *     public-safe subset, the amount, currency, line items, memo, status, and
 *     the issuer's PUBLIC pay coordinates (display handle + Sui address) so the
 *     pay page can route into /app/pay. The customer email is NEVER exposed
 *     publicly; the customer name is (it's printed on the invoice itself).
 *
 * POST /api/invoices/[id], owner-only mutations.
 *   • { action: 'void' }              → mark an open invoice void.
 *   • { action: 'mark-paid', digest } → mark an open invoice paid. The digest is
 *                                        VERIFIED on-chain via the shared settle
 *                                        helper (must succeed + credit the
 *                                        issuer), not merely recorded.
 */

/** A plausible base58 Sui transaction digest (same shape the settle route uses). */
const DIGEST_RE = /^[1-9A-HJ-NP-Za-km-z]{40,60}$/;

/** The issuer's public-facing display handle (talise handle, else short addr). */
function issuerHandle(u: {
  talise_username: string | null;
  suins_subname?: string | null;
  business_handle: string | null;
  name: string | null;
  sui_address: string;
}): string {
  if (u.talise_username) return `@${u.talise_username}`;
  if (u.suins_subname) return u.suins_subname;
  if (u.business_handle) return `@${u.business_handle}`;
  if (u.name) return u.name;
  return `${u.sui_address.slice(0, 6)}…${u.sui_address.slice(-4)}`;
}

type PublicInvoice = {
  id: string;
  amountUsd: number;
  currency: string;
  customerName: string | null;
  lineItems: WorkInvoice["lineItems"];
  memo: string | null;
  status: WorkInvoice["status"];
  dueMs: number | null;
  createdAt: number;
  issuer: { handle: string; address: string; name: string | null };
};

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const invoice = await workInvoiceById(id);
  if (!invoice) {
    return NextResponse.json({ error: "invoice not found" }, { status: 404 });
  }

  const viewerId = await readEntryIdFromRequest(req);
  if (viewerId === invoice.userId) {
    return NextResponse.json({ invoice, owner: true });
  }

  // Public-safe view. We still need the issuer's pay coordinates so the
  // payer can settle the invoice, load the issuer and project the safe subset.
  const issuer = await userById(invoice.userId);
  if (!issuer) {
    return NextResponse.json({ error: "invoice issuer not found" }, { status: 404 });
  }
  const pub: PublicInvoice = {
    id: invoice.id,
    amountUsd: invoice.amountUsd,
    currency: invoice.currency,
    customerName: invoice.customerName,
    lineItems: invoice.lineItems,
    memo: invoice.memo,
    status: invoice.status,
    dueMs: invoice.dueMs,
    createdAt: invoice.createdAt,
    issuer: {
      handle: issuerHandle(issuer),
      address: issuer.sui_address,
      name: issuer.business_name ?? issuer.name,
    },
  };
  return NextResponse.json({ invoice: pub, owner: false });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const rl = await rateLimitAsync({
    key: `invoices-mutate:user:${userId}`,
    limit: 120,
    windowSec: 3600,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }

  const { id } = await params;
  const invoice = await workInvoiceById(id);
  if (!invoice) {
    return NextResponse.json({ error: "invoice not found" }, { status: 404 });
  }
  if (invoice.userId !== userId) {
    return NextResponse.json(
      { error: "only the issuer can change this invoice" },
      { status: 403 }
    );
  }

  let body: { action?: string; digest?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  if (body.action === "void") {
    if (invoice.status === "paid") {
      return NextResponse.json(
        { error: "A paid invoice can't be voided." },
        { status: 409 }
      );
    }
    await voidWorkInvoice(id);
    return NextResponse.json({ ok: true, status: "void" });
  }

  if (body.action === "mark-paid") {
    const digest = (body.digest ?? "").trim();
    if (!DIGEST_RE.test(digest)) {
      return NextResponse.json(
        { error: "A valid transaction digest is required to mark paid." },
        { status: 400 }
      );
    }
    if (invoice.status !== "open") {
      return NextResponse.json(
        { error: `This invoice is already ${invoice.status}.` },
        { status: 409 }
      );
    }
    // Even though this is an owner-asserted "mark paid", the digest is verified
    // on-chain via the shared settle helper: it must exist, have succeeded, and
    // have credited the issuer's address with USDsui (rejecting bogus digests),
    // and it's replay-guarded just like the public settle path. `trustOwner`
    // only relaxes the lower amount bound, never the verification itself.
    const result = await settleInvoiceByDigest(id, digest, { trustOwner: true });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, status: "paid", digest: result.digest });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
