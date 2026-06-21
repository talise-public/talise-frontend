import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import {
  createInvoice,
  invoicesFor,
  userById,
} from "@/lib/db";
import {
  createWorkInvoice,
  workInvoicesFor,
  sanitizeLineItems,
  normalizeCurrency,
  autoSettleOpenInvoices,
} from "@/lib/invoices";

export const runtime = "nodejs";

/**
 * POST /api/invoices — create an invoice.
 *
 * TWO request shapes are accepted on this one route:
 *
 *   • LEGACY (business B2C checkout): `{ amount, reference?, customerEmail? }`.
 *     Requires a business account. Backward-compatible with the original
 *     route — writes the legacy `invoices` table and returns `{ ok, invoice }`.
 *     Selected when the body has `amount` (string/number) and no rich fields.
 *
 *   • RICH (Work hub): `{ amountUsd?, currency?, customerName?, customerEmail?,
 *     lineItems?:[{description,qty,unitUsd}], memo?, dueMs? }`. Any signed-in
 *     user can issue one. Writes the `work_invoices` table and returns
 *     `{ ok, invoice, payUrl }`. When `lineItems` are supplied, the total is
 *     derived from them (a client-supplied `amountUsd` is only used when there
 *     are no line items). Selected when the body has any rich field.
 *
 * GET /api/invoices — list the caller's invoices.
 *   • Business accounts get their legacy `invoices` rows merged with their
 *     `work_invoices`. Personal accounts get just their `work_invoices`.
 */

const ABS_BASE = (process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/+$/, "");

/** Build the public pay URL for an invoice slug from the request origin. */
function payUrlFor(req: Request, id: string): string {
  let origin = ABS_BASE;
  if (!origin) {
    try {
      origin = new URL(req.url).origin;
    } catch {
      origin = "https://www.talise.io";
    }
  }
  return `${origin}/i/${id}`;
}

function isRichBody(b: Record<string, unknown>): boolean {
  return (
    "lineItems" in b ||
    "amountUsd" in b ||
    "customerName" in b ||
    "currency" in b ||
    "memo" in b ||
    "dueMs" in b
  );
}

export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // Private-beta guardrail: account must be on the app allowlist.
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;

  const rl = await rateLimitAsync({
    key: `invoices-create:user:${userId}`,
    limit: 60,
    windowSec: 3600,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }

  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // ── RICH invoice (Work hub) — any signed-in user. ──────────────────────
  if (isRichBody(body)) {
    let items;
    try {
      items = sanitizeLineItems(body.lineItems);
    } catch (err) {
      return NextResponse.json(
        { error: (err as Error).message || "invalid line items" },
        { status: 400 }
      );
    }

    // Total: derived from line items when present; otherwise the explicit
    // amountUsd. Never trust a client total that contradicts its line items.
    let amountUsd: number;
    if (items.items.length > 0) {
      amountUsd = items.total;
    } else {
      amountUsd = Number(body.amountUsd);
    }
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return NextResponse.json(
        { error: "Invoice total must be greater than zero." },
        { status: 400 }
      );
    }
    if (amountUsd > 1_000_000) {
      return NextResponse.json(
        { error: "Invoice total exceeds the maximum." },
        { status: 400 }
      );
    }

    const invoice = await createWorkInvoice({
      userId,
      amountUsd,
      currency: normalizeCurrency(body.currency),
      customerName:
        typeof body.customerName === "string" ? body.customerName : null,
      customerEmail:
        typeof body.customerEmail === "string" ? body.customerEmail : null,
      lineItems: items.items,
      memo: typeof body.memo === "string" ? body.memo : null,
      dueMs:
        body.dueMs != null && Number.isFinite(Number(body.dueMs))
          ? Number(body.dueMs)
          : null,
    });

    return NextResponse.json({
      ok: true,
      invoice,
      payUrl: payUrlFor(req, invoice.id),
    });
  }

  // ── LEGACY business B2C checkout — UNCHANGED behavior. ─────────────────
  if (user.account_type !== "business") {
    return NextResponse.json(
      { error: "business account required" },
      { status: 403 }
    );
  }
  const amt = Number(body.amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
  }
  const inv = await createInvoice({
    businessUserId: user.id,
    amountUsdc: amt.toFixed(2),
    reference:
      typeof body.reference === "string" ? body.reference.trim() || null : null,
    customerEmail:
      typeof body.customerEmail === "string"
        ? body.customerEmail.trim() || null
        : null,
  });
  return NextResponse.json({ ok: true, invoice: inv });
}

export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let invoices = await workInvoicesFor(userId);

  // Auto-settle: detect direct payments against open invoices (matching
  // incoming credits, verified on-chain by the settle core) so paid status
  // reflects automatically — there's no manual "Mark paid". Bounded to a few
  // RPC verifications per load; re-fetch only when something closed.
  try {
    const settled = await autoSettleOpenInvoices(userId, invoices);
    if (settled > 0) invoices = await workInvoicesFor(userId);
  } catch (err) {
    console.warn(`[invoices] auto-settle sweep failed user=${userId}: ${(err as Error).message}`);
  }

  // Business accounts keep visibility into their legacy checkout invoices —
  // surfaced under a separate key so the Work UI can render the rich list and
  // a legacy section can still read `legacy` if it wants. Personal accounts
  // never have legacy rows.
  let legacy: Awaited<ReturnType<typeof invoicesFor>> = [];
  if (user.account_type === "business") {
    try {
      legacy = await invoicesFor(user.id);
    } catch {
      /* non-fatal */
    }
  }

  return NextResponse.json({ invoices, legacy });
}
