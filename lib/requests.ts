import "server-only";

import { randomBytes } from "node:crypto";
import { db, ensureSchema, schemaVersionGate, userById } from "@/lib/db";
import { getNormalizedTransaction } from "@/lib/sui-shapes";
import { isUsdsui } from "@/lib/usdsui";
import { sealAndStoreNote, fetchAndOpenNote } from "@/lib/cheque-note";

/**
 * Payment requests — the INVERSE of a cheque.
 *
 * A cheque says "I have money for you, come claim it"; a request says "I need
 * $X from you, here's a link to pay me". The requester is the PAYEE: when the
 * request is settled, USDsui is credited to THEIR address (so the settle core
 * here mirrors web/lib/invoices.ts:settleInvoiceByDigest — verify on-chain, sum
 * the credit to the requester, bind by amount, record the digest once).
 *
 * Self-bootstrapping schema in its OWN table (`work_requests`) created by
 * `ensureRequestsSchema()` with a one-SELECT schemaVersionGate, mirroring the
 * web/lib/cheques.ts discipline (reset the memo on failure so a transient DDL
 * error retries; bump REQUESTS_SCHEMA_VERSION when the DDL changes). Postgres
 * DDL only. Does NOT touch web/lib/db.ts.
 *
 * Money is USDsui (6dp, 1:1 USD). `amount_usd` is the canonical figure the
 * payer settles, stored as DOUBLE PRECISION (like invoices, not micros);
 * `currency` is the requester's chosen DISPLAY denomination.
 *
 * An optional private note is encrypted with the cheque-note primitive
 * (AES-256-GCM) and stored on Walrus — only the blob id lands in our DB, never
 * the plaintext. The content key is derived from the request id (the public
 * slug in the link), so exactly whoever holds the link can open the note,
 * matching the request's own "anyone with the link can pay" trust model.
 */

// ── Schema (self-bootstrapping, memoized once-per-process) ──────────────────

let _schemaReady: Promise<void> | null = null;
// Bump whenever ANY DDL below changes — the version gate skips the whole DDL
// replay on every cold start while the stored marker matches.
const REQUESTS_SCHEMA_VERSION = "2026-06-28.1";

export function ensureRequestsSchema(): Promise<void> {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    await ensureSchema();
    const c = db();

    const gate = await schemaVersionGate(
      "work_requests_schema_version",
      REQUESTS_SCHEMA_VERSION
    );
    if (gate.upToDate) return;

    // One row per payment request. `id` is a public slug (used in /req/<id>).
    // `amount_usd` is the canonical settle figure; `currency` is the display
    // denomination. `note_blob_id` is the Walrus blob of the encrypted private
    // note (null if none). The funds are NOT escrowed — settlement is a direct
    // USDsui payment to the requester, verified on-chain by `pay_digest`.
    await c.execute(
      `CREATE TABLE IF NOT EXISTS work_requests (
        id                TEXT PRIMARY KEY,
        user_id           INTEGER NOT NULL,
        amount_usd        DOUBLE PRECISION NOT NULL,
        currency          TEXT NOT NULL DEFAULT 'USD',
        requester_note    TEXT,
        note_blob_id      TEXT,
        status            TEXT NOT NULL DEFAULT 'open',
        expires_at        BIGINT,
        created_at        BIGINT NOT NULL,
        paid_at           BIGINT,
        pay_digest        TEXT,
        paid_from_address TEXT
      )`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS idx_work_requests_user
         ON work_requests (user_id, created_at DESC)`
    );
    // Anti-double-settle: a single on-chain digest may close AT MOST one
    // request. This partial-unique index is the authority that wins a
    // concurrent race (the loser's UPDATE raises a unique violation).
    await c.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_work_requests_pay_digest
         ON work_requests (pay_digest) WHERE pay_digest IS NOT NULL`
    );

    await gate.stamp();
  })().catch((err) => {
    // Reset so a transient DDL error retries on the next call (mirrors
    // ensureChequesSchema discipline).
    _schemaReady = null;
    throw err;
  });
  return _schemaReady;
}

// ── Types ───────────────────────────────────────────────────────────────────

export type RequestStatus = "open" | "paid" | "cancelled" | "expired";

export interface WorkRequestRow {
  id: string;
  user_id: number;
  amount_usd: number;
  currency: string;
  requester_note: string | null;
  note_blob_id: string | null;
  status: RequestStatus;
  expires_at: number | null;
  created_at: number;
  paid_at: number | null;
  pay_digest: string | null;
  paid_from_address: string | null;
}

/** The UI-facing request shape. */
export interface WorkRequest {
  id: string;
  userId: number;
  amountUsd: number;
  currency: string;
  /** A short public label/memo printed on the request (NOT the encrypted note). */
  requesterNote: string | null;
  noteBlobId: string | null;
  status: RequestStatus;
  expiresAt: number | null;
  createdAt: number;
  paidAt: number | null;
  payDigest: string | null;
  paidFromAddress: string | null;
}

/** The public, no-auth preview shown on /req/<id>. */
export interface RequestPreview {
  id: string;
  amountUsd: number;
  currency: string;
  /** The requester's display handle/name (resolved from `users`). */
  requesterDisplay: string;
  /** The requester's Sui address — the payer settles to this. */
  requesterAddress: string;
  /** A short public label/memo (plaintext column). */
  requesterNote: string | null;
  /** The decrypted private note (Walrus), when present + openable. */
  note: string | null;
  status: RequestStatus;
  expiresAt: number | null;
  createdAt: number;
  payDigest: string | null;
  paidAt: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────

const MAX_TEXT = 280;
const REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days default expiry

/** A short, URL-safe public request slug. Mirrors the invoice slug shape. */
function requestSlug(): string {
  return (
    "req_" +
    randomBytes(8).toString("hex")
  );
}

/** A whitelist of supported display currencies (mirrors invoices.ts). */
const ALLOWED_CURRENCIES = new Set([
  "USD", "NGN", "GHS", "KES", "EUR", "GBP",
  "CAD", "ZAR", "JPY", "SGD", "PHP", "IDR", "VND",
]);

/** Coerce + clamp an untrusted currency code to a known one (default USD). */
export function normalizeCurrency(c: unknown): string {
  const up = typeof c === "string" ? c.trim().toUpperCase() : "";
  return ALLOWED_CURRENCIES.has(up) ? up : "USD";
}

/** Parse a stored row into the UI-facing shape. */
export function projectRequest(row: WorkRequestRow): WorkRequest {
  return {
    id: row.id,
    userId: Number(row.user_id),
    amountUsd: Number(row.amount_usd),
    currency: row.currency || "USD",
    requesterNote: row.requester_note,
    noteBlobId: row.note_blob_id,
    status: row.status,
    expiresAt: row.expires_at != null ? Number(row.expires_at) : null,
    createdAt: Number(row.created_at),
    paidAt: row.paid_at != null ? Number(row.paid_at) : null,
    payDigest: row.pay_digest,
    paidFromAddress: row.paid_from_address,
  };
}

/**
 * Resolve a user's public display handle. Mirrors the issuerHandle logic on the
 * public invoice page: prefer the Talise handle, then the SuiNS subname, then a
 * business handle/name, then the legacy name, finally a shortened address.
 */
function requesterDisplayFor(u: {
  talise_username: string | null;
  suins_subname?: string | null;
  business_handle: string | null;
  business_name: string | null;
  name: string | null;
  sui_address: string;
}): string {
  if (u.talise_username) return `${u.talise_username}@talise`;
  if (u.suins_subname) return `${u.suins_subname.replace(/\.talise\.sui$/i, "")}@talise`;
  if (u.business_handle) return `${u.business_handle}@talise`;
  if (u.business_name) return u.business_name;
  if (u.name) return u.name;
  return `${u.sui_address.slice(0, 6)}…${u.sui_address.slice(-4)}`;
}

// ── Writes / reads ─────────────────────────────────────────────────────────

export async function createRequest(input: {
  userId: number;
  amountUsd: number;
  currency: string;
  /** A short public label/memo printed on the request page. */
  requesterNote?: string | null;
  /** Optional PRIVATE note — encrypted with the request id + stored on Walrus. */
  note?: string | null;
  ttlMs?: number | null;
}): Promise<WorkRequest> {
  await ensureRequestsSchema();
  const id = requestSlug();
  const now = Date.now();
  const ttl = input.ttlMs != null && Number.isFinite(input.ttlMs) ? input.ttlMs : REQUEST_TTL_MS;
  const expiresAt = ttl > 0 ? now + ttl : null;

  // Best-effort: the private note is encrypted with the request id (the slug in
  // the link) and stored on Walrus. If Walrus is slow/unavailable we still
  // create the request (note just omitted) — the money link must never fail
  // because of an attached message.
  let noteBlobId: string | null = null;
  if (input.note && input.note.trim()) {
    try {
      noteBlobId = await sealAndStoreNote(id, input.note);
    } catch (e) {
      console.warn(`[requests] note → Walrus failed (proceeding without): ${(e as Error).message}`);
    }
  }

  const c = db();
  await c.execute({
    sql: `INSERT INTO work_requests
            (id, user_id, amount_usd, currency, requester_note, note_blob_id,
             status, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    args: [
      id,
      input.userId,
      Math.round(input.amountUsd * 100) / 100,
      normalizeCurrency(input.currency),
      input.requesterNote?.trim().slice(0, MAX_TEXT) || null,
      noteBlobId,
      expiresAt,
      now,
    ],
  });
  const r = await c.execute({
    sql: "SELECT * FROM work_requests WHERE id = ? LIMIT 1",
    args: [id],
  });
  return projectRequest(r.rows[0] as unknown as WorkRequestRow);
}

/**
 * Lazily flip an open-but-past-expiry request to `expired`. Returns the
 * (possibly mutated) status so callers render the current state. No-op for any
 * non-open request or one without an expiry.
 */
async function expireIfDue(row: WorkRequest): Promise<RequestStatus> {
  if (row.status !== "open" || row.expiresAt == null || row.expiresAt > Date.now()) {
    return row.status;
  }
  await db().execute({
    sql: "UPDATE work_requests SET status = 'expired' WHERE id = ? AND status = 'open'",
    args: [row.id],
  });
  return "expired";
}

export async function getRequest(id: string): Promise<WorkRequest | null> {
  await ensureRequestsSchema();
  const r = await db().execute({
    sql: "SELECT * FROM work_requests WHERE id = ? LIMIT 1",
    args: [id],
  });
  const row = r.rows[0] as unknown as WorkRequestRow | undefined;
  if (!row) return null;
  const req = projectRequest(row);
  req.status = await expireIfDue(req);
  return req;
}

export async function listRequestsFor(userId: number): Promise<WorkRequest[]> {
  await ensureRequestsSchema();
  const r = await db().execute({
    sql: "SELECT * FROM work_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 200",
    args: [userId],
  });
  const rows = (r.rows as unknown as WorkRequestRow[]).map(projectRequest);
  // Lazily expire any open-past-expiry rows so the list is accurate.
  for (const req of rows) {
    req.status = await expireIfDue(req);
  }
  return rows;
}

/**
 * The PUBLIC preview shown on /req/<id> — no auth. Resolves the requester's
 * display + pay address from `users`, and (best-effort) decrypts the private
 * Walrus note. Returns null if the request or its requester is gone.
 */
export async function previewRequest(id: string): Promise<RequestPreview | null> {
  const req = await getRequest(id);
  if (!req) return null;

  const requester = await userById(req.userId);
  if (!requester) return null;

  // Best-effort: open the encrypted note. A failure (Walrus down, corrupt
  // blob) just omits the note — the request still renders + is payable.
  let note: string | null = null;
  if (req.noteBlobId) {
    note = await fetchAndOpenNote(req.id, req.noteBlobId).catch(() => null);
  }

  return {
    id: req.id,
    amountUsd: req.amountUsd,
    currency: req.currency,
    requesterDisplay: requesterDisplayFor(requester),
    requesterAddress: requester.sui_address,
    requesterNote: req.requesterNote,
    note,
    status: req.status,
    expiresAt: req.expiresAt,
    createdAt: req.createdAt,
    payDigest: req.payDigest,
    paidAt: req.paidAt,
  };
}

/** Cancel an open request (owner-only; enforced by the route). No-op if not open. */
export async function cancelRequest(id: string, userId: number): Promise<boolean> {
  await ensureRequestsSchema();
  const r = await db().execute({
    sql: `UPDATE work_requests SET status = 'cancelled'
          WHERE id = ? AND user_id = ? AND status = 'open'`,
    args: [id, userId],
  });
  return (r.rowsAffected ?? 0) > 0;
}

/**
 * Replay guard: true if a DIFFERENT request has already been settled with this
 * exact on-chain digest. One payment digest may close at most one request.
 */
export async function requestDigestUsed(
  digest: string,
  exceptId: string
): Promise<boolean> {
  await ensureRequestsSchema();
  const r = await db().execute({
    sql: "SELECT 1 FROM work_requests WHERE pay_digest = ? AND id <> ? LIMIT 1",
    args: [digest, exceptId],
  });
  return r.rows.length > 0;
}

// ── Trustless settle (verify-by-digest, mirrors invoices) ────────────────────

const USDSUI_MICRO = 1_000_000;

export type SettleRequestResult =
  | { ok: true; status: "paid"; digest: string }
  | { ok: false; status: number; error: string };

/**
 * Verify a payment on-chain and authoritatively close the request — the single
 * source of truth shared by the public pay route and any in-app pay callback.
 * Mirrors web/lib/invoices.ts:settleInvoiceByDigest exactly: the requester is
 * the PAYEE, so we sum USDsui credited to THEIR address and bind by amount.
 *
 * Flow:
 *   1. Load request + requester authoritatively (never trust the caller).
 *   2. Idempotent short-circuit if already paid; reject non-open requests.
 *   3. Replay guard: a digest may close AT MOST one request.
 *   4. Fetch the tx by digest via the canonical verifier; require success.
 *   5. Sum USDsui credited to the requester; capture the payer for the audit.
 *   6. Amount-bind: reject underpayment AND >0.5% overpayment.
 *   7. Authoritative close (the partial-unique pay_digest index wins any race).
 *
 * The amount is ALWAYS bound to the request (within ±0.5% of the requested
 * figure) regardless of who reports the digest, and the digest is ALWAYS
 * verified to exist, succeed, and credit the requester.
 */
export async function settleRequestByDigest(
  id: string,
  digest: string,
  opts: { payerAddressHint?: string | null } = {}
): Promise<SettleRequestResult> {
  await ensureRequestsSchema();

  const request = await getRequest(id);
  if (!request) {
    return { ok: false, status: 404, error: "request not found" };
  }
  // Idempotent: already closed.
  if (request.status === "paid") {
    return { ok: true, status: "paid", digest: request.payDigest ?? digest };
  }
  if (request.status !== "open") {
    return { ok: false, status: 409, error: `this request is ${request.status}` };
  }

  const requester = await userById(request.userId);
  if (!requester) {
    return { ok: false, status: 404, error: "request recipient not found" };
  }
  const requesterAddress = requester.sui_address.toLowerCase();

  // Replay guard: a digest can settle at most one request.
  if (await requestDigestUsed(digest, id)) {
    return {
      ok: false,
      status: 409,
      error: "this transaction already settled another request",
    };
  }

  const expectedMicro = BigInt(Math.round(request.amountUsd * USDSUI_MICRO));

  let tx;
  try {
    tx = await getNormalizedTransaction(digest);
  } catch (e) {
    // RPC indexing lag is common right after broadcast — the caller retries.
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

  // Sum USDsui credited to the requester; capture the payer (matching negative
  // USDsui delta) for the audit trail.
  let receivedMicro = 0n;
  let payerAddress: string | null = null;
  for (const c of tx.balanceChanges) {
    if (!isUsdsui(c.coinType)) continue;
    if (c.ownerAddress === requesterAddress) {
      if (c.amount > 0n) receivedMicro += c.amount;
    } else if (c.amount < 0n && c.ownerAddress && !payerAddress) {
      payerAddress = c.ownerAddress;
    }
  }
  if (!payerAddress && opts.payerAddressHint) {
    payerAddress = opts.payerAddressHint;
  }

  // Bind the payment to THIS request by amount: within ±0.5% of the requested
  // figure, regardless of who reports the digest. (A symmetric tolerance absorbs
  // fee/rounding dust on either side; it must NEVER collapse to a single micro —
  // doing so would let any caller settle a request with a dust payment.)
  const tol = (expectedMicro * 50n) / 10_000n;
  const maxMicro = expectedMicro + tol;
  const lowerBound = expectedMicro > tol ? expectedMicro - tol : 1n;
  if (receivedMicro < lowerBound || receivedMicro > maxMicro) {
    return {
      ok: false,
      status: 400,
      error: `payment of ${Number(receivedMicro) / USDSUI_MICRO} USDsui does not match the ${request.amountUsd} USDsui requested`,
    };
  }

  // Authoritative close: the partial-unique index on pay_digest wins any race.
  let claimed = false;
  try {
    claimed = await markRequestPaid(id, digest, payerAddress);
  } catch (e) {
    if (/duplicate key|unique/i.test((e as Error).message)) {
      return {
        ok: false,
        status: 409,
        error: "this transaction already settled another request",
      };
    }
    throw e;
  }
  if (!claimed) {
    return { ok: false, status: 409, error: "this request is no longer open" };
  }

  return { ok: true, status: "paid", digest };
}

/**
 * Mark an open request paid. Records the on-chain digest + payer address for an
 * audit trail. Guarded on `status = 'open'` so a replay can't re-close a
 * cancelled or already-paid request. The partial-unique index on `pay_digest`
 * (the digest already settled another request) propagates as an error to the
 * caller. Returns true iff THIS call claimed the row.
 *
 * Low-level DB writer — most callers should go through `settleRequestByDigest`,
 * which verifies the payment on-chain first.
 */
export async function markRequestPaid(
  id: string,
  digest: string,
  payerAddress?: string | null
): Promise<boolean> {
  await ensureRequestsSchema();
  const r = await db().execute({
    sql: `UPDATE work_requests
            SET status = 'paid', paid_at = ?, pay_digest = ?, paid_from_address = ?
          WHERE id = ? AND status = 'open'`,
    args: [Date.now(), digest, payerAddress ?? null, id],
  });
  return (r.rowsAffected ?? 0) > 0;
}
