import "server-only";

import { db, ensureSchema, userById } from "@/lib/db";
import { getNormalizedTransaction } from "@/lib/sui-shapes";
import { isUsdsui } from "@/lib/usdsui";
import { readActivitySnapshot } from "@/lib/snapshots";

/**
 * Invoices v2, the Work hub's "get paid for work" backend.
 *
 * The original B2C-checkout invoice lived in the legacy `invoices` table
 * (web/lib/db.ts: createInvoice / invoicesFor / invoiceBySlug /
 * markInvoicePaid), keyed to a `business_user_id` and a flat `amount_usdc`
 * string. That path stays untouched and keeps working, the legacy POST in
 * /api/invoices is preserved for business accounts.
 *
 * This module adds a RICHER, account-type-agnostic invoice that ANY signed-in
 * user can issue: line items, a memo, a customer name/email, a currency the
 * invoice is denominated in (display only, money still moves as 1:1 USDsui),
 * and a public pay slug. It lives in its OWN table (`work_invoices`) created by
 * `ensureWorkSchema()` so it never collides with the legacy `invoices` table
 * or any other agent's schema.
 *
 * Postgres DDL only (SERIAL / BIGINT / DOUBLE PRECISION / TEXT / ON CONFLICT).
 * The schema bootstrap is memoized once-per-process, mirroring
 * web/lib/streams.ts:ensureStreamsSchema discipline (reset on failure so a
 * transient error retries).
 *
 * Money is USDsui (6dp, 1:1 USD). `amount_usd` is the canonical figure the
 * payer settles; `currency` is the issuer's chosen display denomination.
 */

// ── Schema (self-bootstrapping, memoized once-per-process) ──────────────────
let _workSchemaReadyP: Promise<void> | null = null;

/**
 * Idempotent CREATE TABLE IF NOT EXISTS for the Work area's own tables:
 * `work_invoices` (rich invoices) and `work_contracts` (streamed work pay).
 * Safe to call on every request, it's a no-op after the first call on an
 * instance. Postgres DDL.
 */
export function ensureWorkSchema(): Promise<void> {
  if (_workSchemaReadyP) return _workSchemaReadyP;
  _workSchemaReadyP = (async () => {
    await ensureSchema();
    const c = db();

    // One row per issued invoice. `id` is a public slug (used in /i/<id>).
    // `line_items` is a JSON array of {description, qty, unitUsd}. `amount_usd`
    // is the canonical settle figure; `currency` is the display denomination.
    await c.execute(
      `CREATE TABLE IF NOT EXISTS work_invoices (
        id              TEXT PRIMARY KEY,
        user_id         INTEGER NOT NULL,
        amount_usd      DOUBLE PRECISION NOT NULL,
        currency        TEXT NOT NULL DEFAULT 'USD',
        customer_name   TEXT,
        customer_email  TEXT,
        line_items      TEXT NOT NULL DEFAULT '[]',
        memo            TEXT,
        status          TEXT NOT NULL DEFAULT 'open',
        due_ms          BIGINT,
        created_at      BIGINT NOT NULL,
        paid_at         BIGINT,
        pay_digest      TEXT,
        paid_by_address TEXT
      )`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS idx_work_invoices_user
         ON work_invoices (user_id, created_at DESC)`
    );
    // Anti-double-settle: a single on-chain digest may close AT MOST one
    // invoice. The pre-check in workInvoiceDigestUsed is a fast path; THIS
    // partial-unique index is the authority that wins a concurrent race (the
    // loser's UPDATE raises a unique violation).
    await c.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_work_invoices_pay_digest
         ON work_invoices (pay_digest) WHERE pay_digest IS NOT NULL`
    );

    // One row per work contract, an employment/freelance arrangement that
    // pays via an underlying stream (streams.id is the fk). The contract row
    // holds the human-facing metadata (role, rate, cadence) so the UI can
    // render "pays @alice $X every week" without re-deriving it from the
    // stream's raw tranche math.
    await c.execute(
      `CREATE TABLE IF NOT EXISTS work_contracts (
        id              TEXT PRIMARY KEY,
        user_id         INTEGER NOT NULL,
        payee_address   TEXT NOT NULL,
        payee_handle    TEXT,
        title           TEXT NOT NULL,
        rate_usd        DOUBLE PRECISION NOT NULL,
        cadence         TEXT NOT NULL,
        periods         INTEGER NOT NULL,
        stream_id       TEXT NOT NULL,
        funding_digest  TEXT,
        status          TEXT NOT NULL DEFAULT 'active',
        created_at      BIGINT NOT NULL,
        updated_at      BIGINT NOT NULL
      )`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS idx_work_contracts_user
         ON work_contracts (user_id, created_at DESC)`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS idx_work_contracts_stream
         ON work_contracts (stream_id)`
    );
  })().catch((err) => {
    _workSchemaReadyP = null;
    throw err;
  });
  return _workSchemaReadyP;
}

// ── Types ───────────────────────────────────────────────────────────────────

export type InvoiceStatus = "open" | "paid" | "void";

export interface WorkInvoiceLineItem {
  description: string;
  qty: number;
  unitUsd: number;
}

export interface WorkInvoiceRow {
  id: string;
  user_id: number;
  amount_usd: number;
  currency: string;
  customer_name: string | null;
  customer_email: string | null;
  line_items: string;
  memo: string | null;
  status: InvoiceStatus;
  due_ms: number | null;
  created_at: number;
  paid_at: number | null;
  pay_digest: string | null;
  paid_by_address: string | null;
}

/** The UI-facing invoice shape (parsed line items, no raw JSON string). */
export interface WorkInvoice {
  id: string;
  userId: number;
  amountUsd: number;
  currency: string;
  customerName: string | null;
  customerEmail: string | null;
  lineItems: WorkInvoiceLineItem[];
  memo: string | null;
  status: InvoiceStatus;
  dueMs: number | null;
  createdAt: number;
  paidAt: number | null;
  payDigest: string | null;
  paidByAddress: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** A short, URL-safe public invoice slug. Mirrors the legacy invoiceSlug shape. */
function invoiceSlug(): string {
  return (
    "inv_" +
    Math.random().toString(36).slice(2, 7) +
    Math.random().toString(36).slice(2, 7)
  );
}

const MAX_LINE_ITEMS = 50;
const MAX_TEXT = 280;

/** A whitelist of supported display currencies (mirrors the app's picker). */
const ALLOWED_CURRENCIES = new Set([
  "USD", "NGN", "GHS", "KES", "EUR", "GBP",
  "CAD", "ZAR", "JPY", "SGD", "PHP", "IDR", "VND",
]);

/** Coerce + clamp an untrusted currency code to a known one (default USD). */
export function normalizeCurrency(c: unknown): string {
  const up = typeof c === "string" ? c.trim().toUpperCase() : "";
  return ALLOWED_CURRENCIES.has(up) ? up : "USD";
}

/**
 * Validate + normalize a client-supplied line-item array. Returns the cleaned
 * items and the derived total (sum of qty*unitUsd, rounded to cents). Throws
 * a plain Error with a friendly message on a malformed payload.
 */
export function sanitizeLineItems(
  raw: unknown
): { items: WorkInvoiceLineItem[]; total: number } {
  if (!Array.isArray(raw)) {
    return { items: [], total: 0 };
  }
  if (raw.length > MAX_LINE_ITEMS) {
    throw new Error(`An invoice can have at most ${MAX_LINE_ITEMS} line items.`);
  }
  const items: WorkInvoiceLineItem[] = [];
  let total = 0;
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const obj = r as Record<string, unknown>;
    const description = String(obj.description ?? "").trim().slice(0, MAX_TEXT);
    const qty = Number(obj.qty);
    const unitUsd = Number(obj.unitUsd);
    if (!description) continue;
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error("Each line item needs a quantity greater than zero.");
    }
    if (!Number.isFinite(unitUsd) || unitUsd < 0) {
      throw new Error("Each line item needs a valid unit price.");
    }
    const line = Math.round(qty * unitUsd * 100) / 100;
    items.push({ description, qty, unitUsd });
    total += line;
  }
  return { items, total: Math.round(total * 100) / 100 };
}

/** Parse a stored row into the UI-facing shape. */
export function projectInvoice(row: WorkInvoiceRow): WorkInvoice {
  let lineItems: WorkInvoiceLineItem[] = [];
  try {
    const parsed = JSON.parse(row.line_items || "[]");
    if (Array.isArray(parsed)) lineItems = parsed as WorkInvoiceLineItem[];
  } catch {
    /* tolerate a corrupt blob, render an empty list rather than 500 */
  }
  return {
    id: row.id,
    userId: Number(row.user_id),
    amountUsd: Number(row.amount_usd),
    currency: row.currency || "USD",
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    lineItems,
    memo: row.memo,
    status: row.status,
    dueMs: row.due_ms != null ? Number(row.due_ms) : null,
    createdAt: Number(row.created_at),
    paidAt: row.paid_at != null ? Number(row.paid_at) : null,
    payDigest: row.pay_digest,
    paidByAddress: row.paid_by_address,
  };
}

// ── Writes / reads ─────────────────────────────────────────────────────────

export async function createWorkInvoice(input: {
  userId: number;
  amountUsd: number;
  currency: string;
  customerName?: string | null;
  customerEmail?: string | null;
  lineItems: WorkInvoiceLineItem[];
  memo?: string | null;
  dueMs?: number | null;
}): Promise<WorkInvoice> {
  await ensureWorkSchema();
  const id = invoiceSlug();
  const now = Date.now();
  const c = db();
  await c.execute({
    sql: `INSERT INTO work_invoices
            (id, user_id, amount_usd, currency, customer_name, customer_email,
             line_items, memo, status, due_ms, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    args: [
      id,
      input.userId,
      Math.round(input.amountUsd * 100) / 100,
      normalizeCurrency(input.currency),
      input.customerName?.trim().slice(0, MAX_TEXT) || null,
      input.customerEmail?.trim().slice(0, MAX_TEXT) || null,
      JSON.stringify(input.lineItems ?? []),
      input.memo?.trim().slice(0, MAX_TEXT) || null,
      input.dueMs && Number.isFinite(input.dueMs) ? Math.floor(input.dueMs) : null,
      now,
    ],
  });
  const r = await c.execute({
    sql: "SELECT * FROM work_invoices WHERE id = ? LIMIT 1",
    args: [id],
  });
  return projectInvoice(r.rows[0] as unknown as WorkInvoiceRow);
}

export async function workInvoicesFor(userId: number): Promise<WorkInvoice[]> {
  await ensureWorkSchema();
  const r = await db().execute({
    sql: "SELECT * FROM work_invoices WHERE user_id = ? ORDER BY created_at DESC LIMIT 200",
    args: [userId],
  });
  return (r.rows as unknown as WorkInvoiceRow[]).map(projectInvoice);
}

export async function workInvoiceById(id: string): Promise<WorkInvoice | null> {
  await ensureWorkSchema();
  const r = await db().execute({
    sql: "SELECT * FROM work_invoices WHERE id = ? LIMIT 1",
    args: [id],
  });
  const row = r.rows[0] as unknown as WorkInvoiceRow | undefined;
  return row ? projectInvoice(row) : null;
}

/** Void an open invoice (owner-only; enforced by the route). No-op if not open. */
export async function voidWorkInvoice(id: string): Promise<void> {
  await ensureWorkSchema();
  await db().execute({
    sql: "UPDATE work_invoices SET status = 'void' WHERE id = ? AND status = 'open'",
    args: [id],
  });
}

/**
 * Replay guard: true if a DIFFERENT invoice has already been settled with this
 * exact on-chain digest. One payment digest may close at most one invoice, so
 * a payment to a merchant can't be reused to clear a second same-amount invoice.
 */
export async function workInvoiceDigestUsed(
  digest: string,
  exceptId: string
): Promise<boolean> {
  await ensureWorkSchema();
  const r = await db().execute({
    sql: "SELECT 1 FROM work_invoices WHERE pay_digest = ? AND id <> ? LIMIT 1",
    args: [digest, exceptId],
  });
  return r.rows.length > 0;
}

// ── Trustless settle (shared verify-and-close core) ─────────────────────────

const USDSUI_MICRO = 1_000_000;

/**
 * The outcome of a settle attempt. `ok` carries the recorded digest; a failure
 * carries an HTTP-shaped status + a human message so every caller (the public
 * settle route AND the owner mark-paid route) reports the same thing.
 */
export type SettleInvoiceResult =
  | { ok: true; status: "paid"; digest: string }
  | { ok: false; status: number; error: string };

/**
 * Verify a payment on-chain and authoritatively close the invoice, the single
 * source of truth shared by the public settle route and the owner's "mark paid"
 * action.
 *
 * The flow (lifted verbatim from the old settle route so behavior is unchanged):
 *   1. Load invoice + issuer authoritatively (never trust the caller's claim).
 *   2. Idempotent short-circuit if already paid; reject non-open invoices.
 *   3. Replay guard: a digest may close AT MOST one invoice.
 *   4. Fetch the tx by digest via the canonical verifier; require success.
 *   5. Sum USDsui credited to the issuer; capture the payer for the audit trail.
 *   6. Amount-bind: reject underpayment AND >0.5% overpayment (so a larger
 *      payment meant for another invoice can't close a smaller one).
 *   7. Authoritative close via markWorkInvoicePaid (the partial-unique index on
 *      pay_digest wins any concurrent race).
 *
 * `trustOwner` does NOT skip on-chain verification, the digest is ALWAYS
 * verified to exist, succeed, and credit the issuer. It only relaxes the
 * amount-binding's lower bound: an owner asserting "this got paid" may record a
 * payment that credited the issuer at least 1 micro-unit of USDsui (e.g. paid
 * partially, or off a rounded figure) without it being silently rejected, while
 * still rejecting an obviously-bogus digest that never paid the issuer at all.
 */
export async function settleInvoiceByDigest(
  id: string,
  digest: string,
  opts: { trustOwner?: boolean } = {}
): Promise<SettleInvoiceResult> {
  await ensureWorkSchema();

  const invoice = await workInvoiceById(id);
  if (!invoice) {
    return { ok: false, status: 404, error: "invoice not found" };
  }
  // Idempotent: already closed.
  if (invoice.status === "paid") {
    return { ok: true, status: "paid", digest: invoice.payDigest ?? digest };
  }
  if (invoice.status !== "open") {
    return { ok: false, status: 409, error: `this invoice is ${invoice.status}` };
  }

  const issuer = await userById(invoice.userId);
  if (!issuer) {
    return { ok: false, status: 404, error: "invoice issuer not found" };
  }
  const issuerAddress = issuer.sui_address.toLowerCase();

  // Replay guard: a digest can settle at most one invoice.
  if (await workInvoiceDigestUsed(digest, id)) {
    return {
      ok: false,
      status: 409,
      error: "this transaction already settled another invoice",
    };
  }

  // Tolerance for u64<->float rounding (1 micro-unit = 1e-6 USDsui).
  const expectedMicro = BigInt(Math.round(invoice.amountUsd * USDSUI_MICRO));

  let tx;
  try {
    tx = await getNormalizedTransaction(digest);
  } catch (e) {
    // RPC indexing lag is common right after broadcast, the caller retries.
    return {
      ok: false,
      status: 400,
      error: `could not verify payment yet: ${(e as Error).message}`,
    };
  }

  if (tx.status !== "success") {
    return {
      ok: false,
      status: 400,
      error: `payment transaction did not succeed (${tx.status})`,
    };
  }

  // Sum USDsui credited to the issuer; capture the payer (matching negative
  // USDsui delta) for the audit trail.
  let receivedMicro = 0n;
  let payerAddress: string | null = null;
  for (const c of tx.balanceChanges) {
    if (!isUsdsui(c.coinType)) continue;
    if (c.ownerAddress === issuerAddress) {
      if (c.amount > 0n) receivedMicro += c.amount;
    } else if (c.amount < 0n && c.ownerAddress && !payerAddress) {
      payerAddress = c.ownerAddress;
    }
  }

  // Bind the payment to THIS invoice by amount. The public path rejects
  // underpayment AND gross overpayment; an owner-asserted close keeps the same
  // upper bound (no double-close of a bigger invoice) but only requires that
  // the issuer was credited SOMETHING (a verified, non-bogus digest).
  const maxMicro = expectedMicro + (expectedMicro * 50n) / 10_000n;
  const lowerBound = opts.trustOwner ? 1n : expectedMicro;
  if (receivedMicro < lowerBound || receivedMicro > maxMicro) {
    return {
      ok: false,
      status: 400,
      error: `payment of ${Number(receivedMicro) / USDSUI_MICRO} USDsui does not match the ${invoice.amountUsd} USDsui due`,
    };
  }

  // Authoritative close: the partial-unique index on pay_digest wins any race
  // (a digest that already settled another invoice raises a unique violation).
  let claimed = false;
  try {
    claimed = await markWorkInvoicePaid({ id, digest, payerAddress });
  } catch (e) {
    if (/duplicate key|unique/i.test((e as Error).message)) {
      return {
        ok: false,
        status: 409,
        error: "this transaction already settled another invoice",
      };
    }
    throw e;
  }
  if (!claimed) {
    return { ok: false, status: 409, error: "this invoice is no longer open" };
  }

  return { ok: true, status: "paid", digest };
}

// ── Auto-settle sweep ────────────────────────────────────────────────────────

/**
 * Cap on on-chain verifications per sweep, each is one RPC round-trip, and
 * the sweep runs inline on the owner's invoice-list load.
 */
const AUTO_SETTLE_MAX_VERIFICATIONS = 4;

/**
 * Detect direct payments against OPEN invoices automatically, there is no
 * manual "Mark paid" anymore (founder directive, 2026-06-11: "if it's paid,
 * it should automatically reflect that").
 *
 * A payer who settles through the public /i/<id> page already closes the
 * invoice trustlessly (the page submits the digest). This sweep covers the
 * payer who paid the issuer DIRECTLY (handle/address send) and never touched
 * the invoice page: it scans the issuer's activity snapshot for incoming
 * USDsui credits that match an open invoice, same amount (the settle core's
 * exact-amount ±0.5% bound), received after the invoice was created, and
 * runs each candidate through `settleInvoiceByDigest`, which re-verifies the
 * tx ON-CHAIN and enforces the one-digest-one-invoice replay guard. A wrong
 * candidate simply fails verification; nothing here trusts the snapshot.
 *
 * Oldest invoice first (deterministic when two open invoices share an
 * amount), bounded to a few verifications per call. Returns the number of
 * invoices settled, callers re-fetch the list when > 0.
 */
export async function autoSettleOpenInvoices(
  userId: number,
  invoices: WorkInvoice[]
): Promise<number> {
  const open = invoices
    .filter((i) => i.status === "open")
    .sort((a, b) => a.createdAt - b.createdAt);
  if (open.length === 0) return 0;

  const snap = await readActivitySnapshot(userId).catch(() => null);
  if (!snap || !Array.isArray(snap.entries)) return 0;

  type CreditEntry = {
    digest?: unknown;
    direction?: unknown;
    amountUsdsui?: unknown;
    timestampMs?: unknown;
  };
  const credits = (snap.entries as CreditEntry[]).filter(
    (e) =>
      e.direction === "received" &&
      typeof e.digest === "string" &&
      typeof e.amountUsdsui === "number" &&
      e.amountUsdsui > 0 &&
      typeof e.timestampMs === "number"
  ) as { digest: string; amountUsdsui: number; timestampMs: number }[];
  if (credits.length === 0) return 0;

  let verifications = 0;
  let settled = 0;
  const used = new Set<string>();
  for (const inv of open) {
    if (verifications >= AUTO_SETTLE_MAX_VERIFICATIONS) break;
    // Mirror the settle core's bound (expected ≤ paid ≤ expected + 0.5%) so
    // we only spend RPC on candidates that can actually pass.
    const min = inv.amountUsd - 1e-6;
    const max = inv.amountUsd * 1.005 + 1e-6;
    for (const c of credits) {
      if (used.has(c.digest)) continue;
      if (c.timestampMs < inv.createdAt) continue;
      if (c.amountUsdsui < min || c.amountUsdsui > max) continue;
      verifications++;
      try {
        const r = await settleInvoiceByDigest(inv.id, c.digest);
        if (r.ok) {
          used.add(c.digest);
          settled++;
          break; // this invoice is closed, next invoice
        }
      } catch (err) {
        console.warn(
          `[invoices] auto-settle verify failed inv=${inv.id} digest=${c.digest}: ${(err as Error).message}`
        );
      }
      if (verifications >= AUTO_SETTLE_MAX_VERIFICATIONS) break;
    }
  }
  if (settled > 0) {
    console.log(`[invoices] auto-settled ${settled} invoice(s) for user=${userId}`);
  }
  return settled;
}

/**
 * Mark an open invoice paid. Records the on-chain digest + payer address for an
 * audit trail. Guarded on `status = 'open'` so a replay can't re-close a voided
 * or already-paid invoice.
 */
export async function markWorkInvoicePaid(input: {
  id: string;
  digest: string;
  payerAddress?: string | null;
}): Promise<boolean> {
  await ensureWorkSchema();
  // Returns true iff THIS call claimed the row. A 0-row result means the
  // invoice was no longer open; a unique-violation on pay_digest (the digest
  // already settled another invoice) propagates to the caller as an error.
  const r = await db().execute({
    sql: `UPDATE work_invoices
            SET status = 'paid', paid_at = ?, pay_digest = ?, paid_by_address = ?
          WHERE id = ? AND status = 'open'`,
    args: [
      Date.now(),
      input.digest,
      input.payerAddress ?? null,
      input.id,
    ],
  });
  return (r.rowsAffected ?? 0) > 0;
}
