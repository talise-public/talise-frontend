import "server-only";

import { db, ensureSchema } from "@/lib/db";
import type { RateLimitResult } from "@/lib/rate-limit";

/**
 * Durable fixed-window counter in Postgres.
 *
 * WHY THIS EXISTS
 * `rateLimitAsync` prefers Upstash Redis, but `UPSTASH_REDIS_REST_URL` /
 * `_TOKEN` are unset in production (blank placeholders), so it silently
 * degrades to a per-lambda in-memory Map. On Vercel's fan-out the effective
 * cap is then N_instances × limit, and it resets on every cold start — i.e.
 * for the growth surface (referral / onboarding / waitlist) the limiter was
 * decorative (audit finding F3).
 *
 * Postgres is the one shared, durable store this app definitely has, so it
 * is the fallback: one UPSERT per check gives a GLOBAL count across every
 * instance and region. It costs a round-trip on a pool that is small in
 * prod, which is exactly why this is scoped to the abuse-sensitive growth
 * routes (single-digit QPS) and NOT to the money paths — do not wire this
 * into send/limit/quote flows.
 *
 * ALGORITHM
 * The window start is folded INTO the primary key
 * (`<key>|<windowStartMs>`), so there is no TTL/reset bookkeeping and no
 * read-modify-write race: a single
 * `INSERT … ON CONFLICT DO UPDATE SET hits = hits + 1 RETURNING hits` is
 * atomic in Postgres. Expired rows are swept opportunistically.
 *
 * FAILURE POLICY
 * This function THROWS on any DB error. It does not decide policy — the
 * caller (lib/abuse/guard.ts) fails CLOSED for growth routes. Throwing
 * keeps that decision in one place.
 */

const TABLE = "abuse_rate_counters";

let schemaP: Promise<void> | null = null;

/**
 * Lazily create the counter table. Memoised per instance; on failure the
 * memo is cleared so the next request retries instead of caching a broken
 * promise forever (same shape as db.ts's `_schemaReadyP`).
 *
 * Postgres DDL only (the libSQL-shaped adapter speaks Postgres underneath).
 * No FK to `users`: the key space is opaque strings (`ip:…`, `user:…`) and a
 * counter must never be able to block on or cascade from a user row.
 */
export async function ensureAbuseCounterSchema(): Promise<void> {
  if (!schemaP) {
    schemaP = (async () => {
      await ensureSchema();
      await db().execute(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          bucket TEXT PRIMARY KEY,
          hits INTEGER NOT NULL,
          reset_at BIGINT NOT NULL
        )
      `);
      // Sweep index: the GC deletes by reset_at, and without this it would
      // seq-scan a table that sees one row per (key, window).
      await db().execute(
        `CREATE INDEX IF NOT EXISTS idx_abuse_counters_reset ON ${TABLE}(reset_at)`
      );
    })().catch((e) => {
      schemaP = null;
      throw e;
    });
  }
  return schemaP;
}

// Opportunistic GC. Every N checks we delete rows whose window closed a
// while ago. Best-effort and fire-and-forget: a failed sweep must never
// turn into a failed signup. `reset_at < now - GC_GRACE_MS` keeps the
// just-closed window around briefly so a straggling request still counts
// against the right bucket rather than opening a fresh one.
let opsSinceSweep = 0;
const SWEEP_EVERY = 200;
const GC_GRACE_MS = 60_000;

function maybeSweep(now: number): void {
  if (++opsSinceSweep < SWEEP_EVERY) return;
  opsSinceSweep = 0;
  void db()
    .execute({
      sql: `DELETE FROM ${TABLE} WHERE reset_at < ?`,
      args: [now - GC_GRACE_MS],
    })
    .catch(() => null);
}

export interface DurableWindowOptions {
  /** Opaque bucket key, e.g. `referral-capture:ip:1.2.3.4`. */
  key: string;
  limit: number;
  windowSec: number;
}

/**
 * Increment and test the durable counter for `key`.
 * Throws if Postgres is unreachable — the caller decides the policy.
 */
export async function pgFixedWindow(
  opts: DurableWindowOptions
): Promise<RateLimitResult> {
  const { key, limit, windowSec } = opts;
  await ensureAbuseCounterSchema();

  const now = Date.now();
  const windowMs = Math.max(1, windowSec) * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;
  const bucket = `${key}|${windowStart}`;

  const r = await db().execute({
    sql: `INSERT INTO ${TABLE} (bucket, hits, reset_at)
          VALUES (?, 1, ?)
          ON CONFLICT (bucket) DO UPDATE SET hits = ${TABLE}.hits + 1
          RETURNING hits`,
    args: [bucket, resetAt],
  });

  maybeSweep(now);

  // A missing RETURNING row would mean "we don't know the count", which for
  // a fail-closed caller must be an error, not an implicit allow.
  const hits = Number(r.rows[0]?.hits);
  if (!Number.isFinite(hits)) {
    throw new Error(`${TABLE} upsert returned no count for ${bucket}`);
  }

  if (hits <= limit) return { ok: true };
  return {
    ok: false,
    retryAfterSec: Math.max(1, Math.ceil((resetAt - now) / 1000)),
  };
}
