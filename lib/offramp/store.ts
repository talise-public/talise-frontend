import "server-only";

import { createHash } from "node:crypto";

import { db, ensureSchema, schemaVersionGate } from "@/lib/db";

/**
 * Persistence owned by the off-ramp provider layer.
 *
 * `lib/db.ts` is owned elsewhere, so this module bootstraps its own tables
 * following the repo's `ensure…Schema()` + `schemaVersionGate` pattern
 * (lib/payout-teams.ts, lib/cheques.ts). Postgres DDL only.
 *
 * Three tables, each solving a money-safety hole on the payout path:
 *
 *  1. `offramp_provider_health` , shared circuit-breaker state. Serverless runs
 *     many isolated instances, so per-process counters can't notice that a
 *     provider is down: instance A trips while B keeps handing out deposit
 *     addresses. The breaker state has to be shared, hence a table.
 *
 *  2. `offramp_intents` , idempotency claims. A payout submission must be
 *     idempotent or a client retry after a timeout creates a SECOND order with
 *     a SECOND deposit address; a client that then funds both has double-paid
 *     with no way to unwind. A claim row maps an idempotency key to the order
 *     that was actually created, so retries replay the original answer.
 *
 *  3. `offramp_attempts` , an append-only record of every fiat-out attempt
 *     across ALL rails (Linq NGN, Bridge USD/EUR). `linq_offramps` only knows
 *     about Linq, so before this table Bridge cash-outs were invisible: no
 *     audit trail, and completely outside the per-account daily cap.
 */

// ─── Schema ─────────────────────────────────────────────────────────────────

let _schemaReady: Promise<void> | null = null;
// Bump whenever ANY DDL below changes.
const OFFRAMP_PROVIDER_SCHEMA_VERSION = "2026-07-25.1";

export function ensureOfframpProviderSchema(): Promise<void> {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    await ensureSchema();
    const c = db();

    const gate = await schemaVersionGate(
      "offramp_provider_schema_version",
      OFFRAMP_PROVIDER_SCHEMA_VERSION
    );
    if (gate.upToDate) return;

    // ── 1. Circuit-breaker state, one row per provider ──────────────────
    // `state` is closed | open | half_open. `consecutive_failures` drives the
    // trip; `opened_at` drives the cooldown. `last_reason` is what an operator
    // reads to know WHY the corridor degraded.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS offramp_provider_health (
        provider             TEXT PRIMARY KEY,
        state                TEXT NOT NULL DEFAULT 'closed',
        consecutive_failures INT  NOT NULL DEFAULT 0,
        consecutive_successes INT NOT NULL DEFAULT 0,
        total_failures       BIGINT NOT NULL DEFAULT 0,
        total_successes      BIGINT NOT NULL DEFAULT 0,
        opened_at            BIGINT,
        last_failure_at      BIGINT,
        last_success_at      BIGINT,
        last_reason          TEXT,
        updated_at           BIGINT NOT NULL
      )
    `);

    // ── 2. Idempotency claims ───────────────────────────────────────────
    // `key` is scoped to the user + corridor by construction (see
    // `intentKey`), so one user's key can never replay another's payout.
    // `response` is the exact JSON we returned for the winning attempt.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS offramp_intents (
        key         TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        provider    TEXT NOT NULL,
        corridor    TEXT NOT NULL,
        our_ref     TEXT,
        provider_ref TEXT,
        response    TEXT,
        state       TEXT NOT NULL DEFAULT 'claimed',
        created_at  BIGINT NOT NULL,
        updated_at  BIGINT NOT NULL
      )
    `);
    await c.execute(
      `CREATE INDEX IF NOT EXISTS idx_offramp_intents_user
         ON offramp_intents (user_id, created_at DESC)`
    );

    // ── 3. Cross-rail attempt ledger ────────────────────────────────────
    // One row per fiat-out attempt on ANY rail. `usd_amount` is the USD (=
    // USDsui at par) leaving the user, which is what the daily cap counts.
    // `terminal` + `state` let the reconciler find what is still in flight.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS offramp_attempts (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL,
        provider      TEXT NOT NULL,
        corridor      TEXT NOT NULL,
        usd_amount    NUMERIC NOT NULL,
        dest_amount   NUMERIC,
        provider_ref  TEXT,
        deposit_address TEXT,
        onchain_digest TEXT,
        state         TEXT NOT NULL DEFAULT 'submitted',
        terminal      BOOLEAN NOT NULL DEFAULT FALSE,
        funded        BOOLEAN NOT NULL DEFAULT FALSE,
        needs_refund  BOOLEAN NOT NULL DEFAULT FALSE,
        reason        TEXT,
        created_at    BIGINT NOT NULL,
        updated_at    BIGINT NOT NULL
      )
    `);
    await c.execute(
      `CREATE INDEX IF NOT EXISTS idx_offramp_attempts_user
         ON offramp_attempts (user_id, created_at DESC)`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS idx_offramp_attempts_open
         ON offramp_attempts (terminal, created_at DESC) WHERE terminal = FALSE`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS idx_offramp_attempts_refund
         ON offramp_attempts (needs_refund, created_at DESC) WHERE needs_refund = TRUE`
    );
    // Provider references must be unique per provider: two attempt rows
    // pointing at one provider order would double-count the daily cap.
    // Deliberately NOT a partial index, Postgres treats NULLs as distinct, so
    // rows without a provider reference are still allowed, and a plain index can
    // be named in `ON CONFLICT (provider, provider_ref)` inference (a partial
    // one would require repeating its predicate at every call site).
    await c.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_offramp_attempts_provider_ref
         ON offramp_attempts (provider, provider_ref)`
    );

    // ── 4. Inbound provider events (replay protection + audit) ──────────
    // Webhooks are replayable by design. Keying on the provider's own event id
    // makes reprocessing a no-op instead of re-applying a state change.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS offramp_provider_events (
        id          TEXT PRIMARY KEY,
        provider    TEXT NOT NULL,
        event_type  TEXT,
        object_id   TEXT,
        object_status TEXT,
        payload     TEXT,
        received_at BIGINT NOT NULL
      )
    `);
    await c.execute(
      `CREATE INDEX IF NOT EXISTS idx_offramp_events_obj
         ON offramp_provider_events (provider, object_id, received_at DESC)`
    );

    await gate.stamp();
  })().catch((e) => {
    // Never cache a failed bootstrap: the next call must retry.
    _schemaReady = null;
    throw e;
  });
  return _schemaReady;
}

// ─── Health rows ────────────────────────────────────────────────────────────

export type BreakerState = "closed" | "open" | "half_open";

export interface ProviderHealthRow {
  provider: string;
  state: BreakerState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalFailures: number;
  totalSuccesses: number;
  openedAt: number | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  lastReason: string | null;
  updatedAt: number;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0);
}

function mapHealth(row: Record<string, unknown>): ProviderHealthRow {
  return {
    provider: String(row.provider),
    state: (String(row.state) as BreakerState) ?? "closed",
    consecutiveFailures: num(row.consecutive_failures),
    consecutiveSuccesses: num(row.consecutive_successes),
    totalFailures: num(row.total_failures),
    totalSuccesses: num(row.total_successes),
    openedAt: row.opened_at == null ? null : num(row.opened_at),
    lastFailureAt: row.last_failure_at == null ? null : num(row.last_failure_at),
    lastSuccessAt: row.last_success_at == null ? null : num(row.last_success_at),
    lastReason: (row.last_reason as string | null) ?? null,
    updatedAt: num(row.updated_at),
  };
}

export async function readProviderHealth(
  provider: string
): Promise<ProviderHealthRow | null> {
  await ensureOfframpProviderSchema();
  const r = await db().execute({
    sql: `SELECT * FROM offramp_provider_health WHERE provider = ? LIMIT 1`,
    args: [provider],
  });
  const row = r.rows[0];
  return row ? mapHealth(row) : null;
}

export async function listProviderHealth(): Promise<ProviderHealthRow[]> {
  await ensureOfframpProviderSchema();
  const r = await db().execute(
    `SELECT * FROM offramp_provider_health ORDER BY provider ASC`
  );
  return r.rows.map(mapHealth);
}

/**
 * Record a SUCCESSFUL provider interaction. Resets the failure streak and, once
 * enough probes have landed, closes a half-open circuit.
 */
export async function recordProviderSuccess(
  provider: string,
  probeSuccessesToClose: number
): Promise<void> {
  await ensureOfframpProviderSchema();
  const now = Date.now();
  await db().execute({
    sql: `INSERT INTO offramp_provider_health
            (provider, state, consecutive_failures, consecutive_successes,
             total_failures, total_successes, last_success_at, updated_at)
          VALUES (?, 'closed', 0, 1, 0, 1, ?, ?)
          ON CONFLICT (provider) DO UPDATE SET
            consecutive_failures = 0,
            consecutive_successes = offramp_provider_health.consecutive_successes + 1,
            total_successes = offramp_provider_health.total_successes + 1,
            last_success_at = EXCLUDED.last_success_at,
            -- A half-open probe only closes the circuit once enough successes
            -- have landed; an already-closed circuit stays closed.
            state = CASE
              WHEN offramp_provider_health.state = 'closed' THEN 'closed'
              WHEN offramp_provider_health.consecutive_successes + 1 >= ? THEN 'closed'
              ELSE offramp_provider_health.state
            END,
            opened_at = CASE
              WHEN offramp_provider_health.state <> 'closed'
                   AND offramp_provider_health.consecutive_successes + 1 >= ?
                THEN NULL
              ELSE offramp_provider_health.opened_at
            END,
            updated_at = EXCLUDED.updated_at`,
    args: [provider, now, now, probeSuccessesToClose, probeSuccessesToClose],
  });
}

/**
 * Record a provider-side FAILURE (network error, 5xx, timeout). Trips the
 * circuit OPEN once `failureThreshold` consecutive failures accumulate.
 *
 * Caller-side failures (a bad bank code, a rejected amount) must NOT come
 * through here: a user typo is not evidence that the rail is down, and counting
 * it would let one bad input take a whole corridor offline.
 */
export async function recordProviderFailure(
  provider: string,
  reason: string,
  failureThreshold: number
): Promise<void> {
  await ensureOfframpProviderSchema();
  const now = Date.now();
  await db().execute({
    sql: `INSERT INTO offramp_provider_health
            (provider, state, consecutive_failures, consecutive_successes,
             total_failures, total_successes, last_failure_at, last_reason,
             opened_at, updated_at)
          VALUES (?, CASE WHEN 1 >= ? THEN 'open' ELSE 'closed' END, 1, 0, 1, 0, ?, ?,
                  CASE WHEN 1 >= ? THEN ? ELSE NULL END, ?)
          ON CONFLICT (provider) DO UPDATE SET
            consecutive_failures = offramp_provider_health.consecutive_failures + 1,
            consecutive_successes = 0,
            total_failures = offramp_provider_health.total_failures + 1,
            last_failure_at = EXCLUDED.last_failure_at,
            last_reason = EXCLUDED.last_reason,
            state = CASE
              WHEN offramp_provider_health.consecutive_failures + 1 >= ? THEN 'open'
              ELSE offramp_provider_health.state
            END,
            -- Re-stamp opened_at on every trip (a failed half-open probe
            -- restarts the cooldown rather than probing in a tight loop).
            opened_at = CASE
              WHEN offramp_provider_health.consecutive_failures + 1 >= ? THEN EXCLUDED.opened_at
              ELSE offramp_provider_health.opened_at
            END,
            updated_at = EXCLUDED.updated_at`,
    args: [
      provider,
      failureThreshold,
      now,
      reason.slice(0, 500),
      failureThreshold,
      now,
      now,
      failureThreshold,
      failureThreshold,
    ],
  });
}

/** Move a provider into HALF_OPEN so exactly one probe is attempted. */
export async function markProviderHalfOpen(provider: string): Promise<boolean> {
  await ensureOfframpProviderSchema();
  const r = await db().execute({
    sql: `UPDATE offramp_provider_health
             SET state = 'half_open', consecutive_successes = 0, updated_at = ?
           WHERE provider = ? AND state = 'open'`,
    args: [Date.now(), provider],
  });
  return (r.rowsAffected ?? 0) > 0;
}

/** Operator override: force a provider's circuit closed (after a fix). */
export async function resetProviderHealth(provider: string): Promise<void> {
  await ensureOfframpProviderSchema();
  await db().execute({
    sql: `INSERT INTO offramp_provider_health
            (provider, state, consecutive_failures, consecutive_successes, updated_at)
          VALUES (?, 'closed', 0, 0, ?)
          ON CONFLICT (provider) DO UPDATE SET
            state = 'closed', consecutive_failures = 0, consecutive_successes = 0,
            opened_at = NULL, last_reason = 'manual reset', updated_at = EXCLUDED.updated_at`,
    args: [provider, Date.now()],
  });
}

// ─── Idempotency claims ─────────────────────────────────────────────────────

/**
 * Build the storage key for an idempotency claim. ALWAYS namespaced by user +
 * corridor so a key value guessed or replayed by another account can never
 * return someone else's payout details.
 */
export function intentKey(input: {
  userId: string | number;
  corridor: string;
  clientKey: string;
}): string {
  const h = createHash("sha256")
    .update(`${input.userId}|${input.corridor}|${input.clientKey}`)
    .digest("hex")
    .slice(0, 40);
  return `${input.corridor.toLowerCase()}_${input.userId}_${h}`;
}

/**
 * Derive an idempotency key from the REQUEST INTENT when the client didn't send
 * one. Bucketing by a short window means a genuine retry (client timeout, lost
 * response, double tap) collapses onto the original order, while a deliberate
 * repeat payment a few minutes later still gets its own order.
 *
 * A client that sends an explicit key gets exact semantics and should; this is
 * the safety net for the shipped app, not the intended contract.
 */
export function fingerprintKey(input: {
  userId: string | number;
  corridor: string;
  amount: number;
  destination: string;
  bucketMs?: number;
}): string {
  const bucket = input.bucketMs ?? 120_000;
  const slot = Math.floor(Date.now() / bucket);
  return intentKey({
    userId: input.userId,
    corridor: input.corridor,
    clientKey: `fp:${input.amount}:${input.destination}:${slot}`,
  });
}

export interface IntentClaim {
  key: string;
  userId: string;
  provider: string;
  corridor: string;
  ourRef: string | null;
  providerRef: string | null;
  response: Record<string, unknown> | null;
  state: string;
  createdAt: number;
}

function mapIntent(row: Record<string, unknown>): IntentClaim {
  let response: Record<string, unknown> | null = null;
  const raw = row.response as string | null;
  if (raw) {
    try {
      const p = JSON.parse(raw) as unknown;
      if (p && typeof p === "object" && !Array.isArray(p)) {
        response = p as Record<string, unknown>;
      }
    } catch {
      /* stored blob unreadable, treat as absent */
    }
  }
  return {
    key: String(row.key),
    userId: String(row.user_id),
    provider: String(row.provider),
    corridor: String(row.corridor),
    ourRef: (row.our_ref as string | null) ?? null,
    providerRef: (row.provider_ref as string | null) ?? null,
    response,
    state: String(row.state ?? "claimed"),
    createdAt: num(row.created_at),
  };
}

export type ClaimResult =
  /** We own the key: proceed to submit the payout, then `completeIntent`. */
  | { claimed: true; key: string }
  /** Somebody already claimed it: replay their answer, submit nothing. */
  | { claimed: false; key: string; existing: IntentClaim };

/**
 * Atomically claim an idempotency key. `INSERT … ON CONFLICT DO NOTHING`
 * means exactly one concurrent caller can win, so two racing requests can never
 * both create a provider order.
 */
export async function claimIntent(input: {
  key: string;
  userId: string | number;
  provider: string;
  corridor: string;
}): Promise<ClaimResult> {
  await ensureOfframpProviderSchema();
  const now = Date.now();
  const c = db();
  const ins = await c.execute({
    sql: `INSERT INTO offramp_intents (key, user_id, provider, corridor, state, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'claimed', ?, ?)
          ON CONFLICT (key) DO NOTHING`,
    args: [input.key, String(input.userId), input.provider, input.corridor, now, now],
  });
  if ((ins.rowsAffected ?? 0) > 0) return { claimed: true, key: input.key };

  const r = await c.execute({
    sql: `SELECT * FROM offramp_intents WHERE key = ? LIMIT 1`,
    args: [input.key],
  });
  const row = r.rows[0];
  if (!row) {
    // Vanishingly unlikely (insert conflicted, row now absent). Treat as ours
    // rather than blocking the user; the provider's own idempotency key is the
    // second line of defence.
    return { claimed: true, key: input.key };
  }
  return { claimed: false, key: input.key, existing: mapIntent(row) };
}

/** Record the outcome of a claimed intent so retries can replay it verbatim. */
export async function completeIntent(input: {
  key: string;
  ourRef?: string;
  providerRef?: string;
  response: Record<string, unknown>;
}): Promise<void> {
  await ensureOfframpProviderSchema();
  await db().execute({
    sql: `UPDATE offramp_intents
             SET our_ref = COALESCE(?, our_ref),
                 provider_ref = COALESCE(?, provider_ref),
                 response = ?, state = 'completed', updated_at = ?
           WHERE key = ?`,
    args: [
      input.ourRef ?? null,
      input.providerRef ?? null,
      JSON.stringify(input.response),
      Date.now(),
      input.key,
    ],
  });
}

/**
 * Release a claim whose payout never got off the ground (provider refused, we
 * couldn't persist). Without this a failed attempt would poison the key and the
 * user's retry would replay an empty answer forever.
 */
export async function releaseIntent(key: string, reason: string): Promise<void> {
  try {
    await ensureOfframpProviderSchema();
    await db().execute({
      sql: `DELETE FROM offramp_intents WHERE key = ? AND state = 'claimed'`,
      args: [key],
    });
  } catch (e) {
    console.warn(
      `[offramp/store] releaseIntent(${key}) failed after "${reason}":`,
      (e as Error).message
    );
  }
}

// ─── Attempt ledger ─────────────────────────────────────────────────────────

export interface AttemptInput {
  id: string;
  userId: string | number;
  provider: string;
  corridor: string;
  usdAmount: number;
  destAmount?: number;
  providerRef?: string;
  depositAddress?: string;
  state?: string;
}

/**
 * Record a fiat-out attempt. Idempotent on `(provider, provider_ref)` so a
 * retried submission that lands on the SAME provider order cannot create a
 * second cap-consuming row.
 */
export async function recordAttempt(input: AttemptInput): Promise<void> {
  await ensureOfframpProviderSchema();
  const now = Date.now();
  await db().execute({
    sql: `INSERT INTO offramp_attempts
            (id, user_id, provider, corridor, usd_amount, dest_amount,
             provider_ref, deposit_address, state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (provider, provider_ref) DO NOTHING`,
    args: [
      input.id,
      String(input.userId),
      input.provider,
      input.corridor,
      input.usdAmount,
      input.destAmount ?? null,
      input.providerRef ?? null,
      input.depositAddress ?? null,
      input.state ?? "submitted",
      now,
      now,
    ],
  });
}

/**
 * Mark an attempt funded (the user's on-chain leg landed). This is the single
 * most important fact on the payout path: after it, a provider failure means
 * the user is OUT the money and a refund is owed.
 */
export async function markAttemptFunded(
  id: string,
  onchainDigest: string
): Promise<void> {
  await ensureOfframpProviderSchema();
  await db().execute({
    sql: `UPDATE offramp_attempts
             SET funded = TRUE, onchain_digest = COALESCE(onchain_digest, ?),
                 updated_at = ?
           WHERE id = ?`,
    args: [onchainDigest, Date.now(), id],
  });
}

/**
 * Settle an attempt. `needsRefund` is set when the attempt was FUNDED and the
 * provider failed: those rows are the refund queue.
 */
export async function settleAttempt(input: {
  id?: string;
  provider?: string;
  providerRef?: string;
  state: string;
  terminal: boolean;
  needsRefund?: boolean;
  reason?: string;
}): Promise<void> {
  await ensureOfframpProviderSchema();
  const where = input.id
    ? { sql: `id = ?`, args: [input.id] }
    : { sql: `provider = ? AND provider_ref = ?`, args: [input.provider, input.providerRef] };
  await db().execute({
    sql: `UPDATE offramp_attempts
             SET state = ?, terminal = ?, updated_at = ?,
                 reason = COALESCE(?, reason),
                 -- Only ever RAISE the refund flag, and only for funded rows.
                 needs_refund = CASE WHEN funded = TRUE AND ? THEN TRUE ELSE needs_refund END
           WHERE ${where.sql}`,
    args: [
      input.state,
      input.terminal,
      Date.now(),
      input.reason ?? null,
      input.needsRefund === true,
      ...where.args,
    ],
  });
}

/**
 * Sum a user's non-failed fiat-out attempts in the trailing window, across ALL
 * rails. Complements `db.sumRecentOfframpUsd` (which only sees `linq_offramps`)
 * so a Bridge USD cash-out counts against the same daily allowance.
 */
export async function sumRecentAttemptUsd(
  userId: string | number,
  sinceMs: number,
  opts?: { excludeProvider?: string }
): Promise<number> {
  await ensureOfframpProviderSchema();
  const args: unknown[] = [String(userId), sinceMs];
  let extra = "";
  if (opts?.excludeProvider) {
    extra = " AND provider <> ?";
    args.push(opts.excludeProvider);
  }
  const r = await db().execute({
    sql: `SELECT COALESCE(SUM(usd_amount), 0) AS total
            FROM offramp_attempts
           WHERE user_id = ? AND created_at >= ?
             AND state NOT IN ('failed', 'cancelled', 'rejected', 'expired', 'refunded')
             ${extra}`,
    args,
  });
  return Number(r.rows[0]?.total ?? 0);
}

/** Attempts that are funded, terminal-failed and still owed a refund. */
export async function listRefundsOwed(limit = 100): Promise<
  Array<{
    id: string;
    userId: string;
    provider: string;
    corridor: string;
    usdAmount: number;
    providerRef: string | null;
    onchainDigest: string | null;
    reason: string | null;
    createdAt: number;
  }>
> {
  await ensureOfframpProviderSchema();
  const r = await db().execute({
    sql: `SELECT id, user_id, provider, corridor, usd_amount, provider_ref,
                 onchain_digest, reason, created_at
            FROM offramp_attempts
           WHERE needs_refund = TRUE
           ORDER BY created_at ASC
           LIMIT ?`,
    args: [limit],
  });
  return r.rows.map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    provider: String(row.provider),
    corridor: String(row.corridor),
    usdAmount: num(row.usd_amount),
    providerRef: (row.provider_ref as string | null) ?? null,
    onchainDigest: (row.onchain_digest as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    createdAt: num(row.created_at),
  }));
}

// ─── Inbound provider events (replay protection) ────────────────────────────

/**
 * Persist an inbound provider event, returning false when we have seen this
 * event id before. Callers MUST skip state mutation on `false`: webhook
 * providers replay aggressively and a replayed "processing" event must not be
 * allowed to walk a settled payout backwards.
 */
export async function recordProviderEvent(input: {
  provider: string;
  eventId: string;
  eventType?: string;
  objectId?: string;
  objectStatus?: string;
  payload?: string;
}): Promise<boolean> {
  await ensureOfframpProviderSchema();
  const id = `${input.provider}:${input.eventId}`;
  const r = await db().execute({
    sql: `INSERT INTO offramp_provider_events
            (id, provider, event_type, object_id, object_status, payload, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO NOTHING`,
    args: [
      id,
      input.provider,
      input.eventType ?? null,
      input.objectId ?? null,
      input.objectStatus ?? null,
      (input.payload ?? "").slice(0, 8000) || null,
      Date.now(),
    ],
  });
  return (r.rowsAffected ?? 0) > 0;
}
