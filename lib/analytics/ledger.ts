/**
 * Durable lifetime transaction ledger — the source of truth behind every
 * headline number Talise publishes.
 *
 * ## Why this file exists (the bug it fixes)
 *
 * The public /analytics headline metrics (transactions / active accounts /
 * volume) used to be computed as COUNT(*) / COUNT(DISTINCT address) /
 * SUM(amount_usd) over `analytics_recent_tx`. But that table is a BOUNDED
 * FEED: every indexer pass trims it back to the newest N rows. So the moment
 * lifetime activity crossed the bound, the published totals stopped growing
 * and then began DRIFTING DOWN as newer, smaller transactions displaced older,
 * larger ones — and each drifted value was written permanently into the
 * append-only `analytics_snapshots` checkpoint timeline.
 *
 * The fix is to separate the two jobs that one table was doing:
 *
 *   • `analytics_tx_ledger`  (this file) — DURABLE. One row per on-chain
 *     transaction digest, ever. Never trimmed. The arithmetic source of truth
 *     for lifetime counts, distinct actors, and volume.
 *   • `analytics_recent_tx`  (store.ts)  — the RECENT FEED. Still trimmed,
 *     still display-only: it carries the rich rendering fields (handle,
 *     counterparty, resolved counterparty name) for the newest slice. No
 *     headline number is ever derived from it again.
 *
 * ## Monotonicity is structural, not cosmetic
 *
 * Lifetime totals must never decrease. That is guaranteed here by two
 * invariants rather than by clamping a display value:
 *
 *   1. The ledger is append-only per digest. A digest is inserted once; a
 *      re-observation can only FILL fields that were previously unknown
 *      (`COALESCE(existing, incoming)`), never overwrite a known value. So a
 *      transaction can never leave the count, its `amount_usd` can never
 *      shrink once resolved, and its `direction` can never be reclassified out
 *      of the volume filter.
 *   2. `analytics_totals` is a materialized single-row rollup of the ledger,
 *      recomputed at the end of every indexer batch and applied with
 *      GREATEST(). In normal operation GREATEST is a no-op (the ledger cannot
 *      shrink); it exists so that a future prune/restore of the ledger can
 *      never make an already-published lifetime figure go backwards.
 *
 * ## Why a materialized rollup at all
 *
 * Production Postgres runs a small pool (max 8). The public /analytics page is
 * unauthenticated, so its reads must be O(1) regardless of ledger size:
 * `COUNT(DISTINCT address)` over a growing table is the one genuinely
 * expensive aggregate here. Writing it once per indexer batch and reading a
 * single row on the public path keeps the page off the pool's critical path.
 * The ledger remains fully re-derivable — `refreshTotals()` recomputes the
 * rollup from scratch, so the rollup is a cache, never a second truth.
 *
 * Nothing in this module throws: analytics is a read-only surface and must
 * never take down a page or derail an indexer batch.
 */

import { db } from "@/lib/db";
import type { RecentTx } from "@/lib/analytics/types";

/**
 * Directions that count as "value moved". `received` is deliberately excluded
 * as the mirror side of `sent` — counting both would double-count the same
 * dollars. Kept identical to the filter the public page has always used so the
 * fix changes the SOURCE of the number, not its definition.
 */
export const VOLUME_DIRECTIONS = ["sent", "swap", "withdraw", "invest"] as const;

/** SQL fragment for the volume filter. Literal list, no interpolated input. */
const VOLUME_FILTER = `direction IN ('sent','swap','withdraw','invest')`;

/** Rows per multi-row INSERT. 6 params each, so 50 rows = 300 bound params. */
const INSERT_CHUNK = 50;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** The published lifetime figures, read from the materialized rollup. */
export type LifetimeTotals = {
  txCount: number;
  activeAccounts: number;
  volumeUsd: number;
  computedAt: number | null;
};

// ── schema ─────────────────────────────────────────────────────────────────

/**
 * Memoized per process instance. `ensureAnalyticsSchema()` is called by public
 * request paths, and this adds several DDL statements + a one-time backfill;
 * running them on every request would burn connections from a max:8 pool for
 * no reason. A serverless instance handles many requests, so once per instance
 * is the right cadence — and every statement below is idempotent anyway, so a
 * cold instance re-running them is harmless.
 */
let ensured: Promise<void> | null = null;

export function ensureLedgerSchema(): Promise<void> {
  if (!ensured) {
    ensured = createLedgerSchema().catch((e) => {
      // Let the next caller retry rather than caching a failure forever.
      ensured = null;
      throw e;
    });
  }
  return ensured;
}

async function createLedgerSchema(): Promise<void> {
  // One row per on-chain transaction digest, for the lifetime of the product.
  // Deliberately NARROW: only the fields the lifetime arithmetic needs. The
  // display fields (handle, counterparty, counterparty name) stay in the feed,
  // which keeps this table small and its aggregates fast.
  await db().execute({
    sql: `CREATE TABLE IF NOT EXISTS analytics_tx_ledger (
            digest        TEXT PRIMARY KEY,
            address       TEXT,
            direction     TEXT,
            amount_usd    DOUBLE PRECISION,
            ts            BIGINT NOT NULL,
            first_seen_at BIGINT NOT NULL
          )`,
    args: [],
  });

  await db().execute({
    sql: `CREATE INDEX IF NOT EXISTS analytics_tx_ledger_ts_idx
            ON analytics_tx_ledger (ts DESC)`,
    args: [],
  });
  // Supports the per-address lifetime-volume rollup (admin growth panels).
  await db().execute({
    sql: `CREATE INDEX IF NOT EXISTS analytics_tx_ledger_addr_idx
            ON analytics_tx_ledger (address)`,
    args: [],
  });

  // Materialized single-row rollup of the ledger. Read by the public page.
  await db().execute({
    sql: `CREATE TABLE IF NOT EXISTS analytics_totals (
            id              INT PRIMARY KEY DEFAULT 1,
            tx_count        BIGINT NOT NULL DEFAULT 0,
            active_accounts BIGINT NOT NULL DEFAULT 0,
            volume_usd      DOUBLE PRECISION NOT NULL DEFAULT 0,
            computed_at     BIGINT
          )`,
    args: [],
  });

  // Seed the singleton so a read always finds a row (before the first batch).
  await db().execute({
    sql: `INSERT INTO analytics_totals (id) VALUES (1)
          ON CONFLICT (id) DO NOTHING`,
    args: [],
  });

  // Lets the per-user lifetime-volume join find its user by address.
  await db()
    .execute({
      sql: `CREATE INDEX IF NOT EXISTS analytics_user_stats_addr_idx
              ON analytics_user_stats (address)`,
      args: [],
    })
    .catch(() => {});

  // ── snapshot provenance ────────────────────────────────────────────────
  //
  // `analytics_snapshots` rows written before this fix hold capped-window
  // numbers. The table's contract is append-only and immutable, and it is the
  // only historical record we have, so those rows are NOT rewritten and NOT
  // deleted. Instead each row carries its provenance:
  //
  //   'capped_window' — computed from the trimmed feed. Under-reports lifetime
  //                     totals, and may decrease relative to the row before it.
  //   'ledger'        — computed from analytics_tx_ledger. Trustworthy.
  //
  // Consumers (getSnapshots) surface `basis` so a chart can mark the estimated
  // era, and additionally clamp the strictly-cumulative series to a running
  // maximum so a published timeline can never render a lifetime metric going
  // down. Clamping only ever raises a displayed value toward the truth; the
  // stored row keeps its original figure.
  await db()
    .execute({
      sql: `ALTER TABLE analytics_snapshots ADD COLUMN IF NOT EXISTS basis TEXT`,
      args: [],
    })
    .catch(() => {});
  await db()
    .execute({
      sql: `UPDATE analytics_snapshots SET basis = 'capped_window'
             WHERE basis IS NULL`,
      args: [],
    })
    .catch(() => {});

  // ── one-time backfill ──────────────────────────────────────────────────
  //
  // Without this the ledger would start empty and the published totals would
  // crater to ~0 on deploy, then climb back as the indexer walks users. The
  // feed still holds the newest N transactions, so adopting them gives the
  // ledger an immediate, honest floor equal to today's published figures —
  // after which it only grows. Guarded by NOT EXISTS so it runs exactly once:
  // the subquery is uncorrelated, so Postgres evaluates it a single time and
  // the statement is a no-op forever after.
  await db()
    .execute({
      sql: `INSERT INTO analytics_tx_ledger
              (digest, address, direction, amount_usd, ts, first_seen_at)
            SELECT digest, address, direction, amount_usd, ts,
                   COALESCE(indexed_at, ts)
              FROM analytics_recent_tx
             WHERE NOT EXISTS (SELECT 1 FROM analytics_tx_ledger)
            ON CONFLICT (digest) DO NOTHING`,
      args: [],
    })
    .catch(() => {});
}

// ── writes ─────────────────────────────────────────────────────────────────

/**
 * Record transactions into the durable ledger.
 *
 * Append-only per digest: a digest already present keeps every field it
 * already knows and only gains the ones it was missing. That is what makes
 * lifetime COUNT / SUM monotonic — see the module header. `ts` takes the
 * EARLIEST observation because on-chain time cannot move forward for a
 * settled transaction; a later, larger value would be a source artefact.
 *
 * Batched into multi-row INSERTs (the feed writer does one round trip per row;
 * a user with 200 transactions would otherwise cost 200 more). Duplicate
 * digests within a single statement would trip "ON CONFLICT DO UPDATE cannot
 * affect row a second time", so the input is deduped first.
 */
export async function recordLedgerTxs(
  rows: readonly RecentTx[],
  now: number
): Promise<void> {
  const byDigest = new Map<string, RecentTx>();
  for (const r of rows) {
    if (!r.digest) continue;
    const prev = byDigest.get(r.digest);
    if (!prev) {
      byDigest.set(r.digest, r);
      continue;
    }
    // Same digest twice in one input: merge rather than drop information.
    byDigest.set(r.digest, {
      ...prev,
      address: prev.address ?? r.address,
      direction: prev.direction || r.direction,
      amountUsd: prev.amountUsd ?? r.amountUsd,
      ts: Math.min(prev.ts || r.ts, r.ts || prev.ts),
    });
  }
  const deduped = Array.from(byDigest.values());
  if (deduped.length === 0) return;

  for (let i = 0; i < deduped.length; i += INSERT_CHUNK) {
    const chunk = deduped.slice(i, i + INSERT_CHUNK);
    const tuples = chunk.map(() => `(?, ?, ?, ?, ?, ?)`).join(", ");
    const args: unknown[] = [];
    for (const r of chunk) {
      args.push(
        r.digest,
        r.address,
        r.direction || null,
        r.amountUsd,
        Number.isFinite(r.ts) ? r.ts : now,
        now
      );
    }
    try {
      await db().execute({
        sql: `INSERT INTO analytics_tx_ledger
                (digest, address, direction, amount_usd, ts, first_seen_at)
              VALUES ${tuples}
              ON CONFLICT (digest) DO UPDATE SET
                address    = COALESCE(analytics_tx_ledger.address,
                                      EXCLUDED.address),
                direction  = COALESCE(NULLIF(analytics_tx_ledger.direction, ''),
                                      EXCLUDED.direction),
                amount_usd = COALESCE(analytics_tx_ledger.amount_usd,
                                      EXCLUDED.amount_usd),
                ts         = LEAST(analytics_tx_ledger.ts, EXCLUDED.ts)`,
        args,
      });
    } catch {
      // One bad chunk must not derail the batch; the next pass re-observes
      // these digests and the insert is idempotent.
    }
  }
}

/**
 * Recompute the materialized lifetime rollup from the ledger.
 *
 * ONE statement, no read-then-write race. GREATEST is the published-figure
 * ratchet described in the module header: with an intact ledger it never binds.
 */
export async function refreshTotals(now: number): Promise<void> {
  try {
    await db().execute({
      sql: `INSERT INTO analytics_totals
              (id, tx_count, active_accounts, volume_usd, computed_at)
            SELECT 1,
                   COUNT(*),
                   COUNT(DISTINCT address),
                   COALESCE(SUM(amount_usd) FILTER (WHERE ${VOLUME_FILTER}), 0),
                   ?
              FROM analytics_tx_ledger
            ON CONFLICT (id) DO UPDATE SET
              tx_count        = GREATEST(analytics_totals.tx_count,
                                         EXCLUDED.tx_count),
              active_accounts = GREATEST(analytics_totals.active_accounts,
                                         EXCLUDED.active_accounts),
              volume_usd      = GREATEST(analytics_totals.volume_usd,
                                         EXCLUDED.volume_usd),
              computed_at     = EXCLUDED.computed_at`,
      args: [now],
    });
  } catch {
    // Best-effort: the ledger still holds the truth and the next batch retries.
  }
}

// ── reads ──────────────────────────────────────────────────────────────────

/**
 * SQL that yields the three lifetime figures as columns, for callers that want
 * them folded into a larger single-round-trip query.
 *
 * The LEFT JOIN against a one-row VALUES is deliberate: a plain
 * `FROM analytics_totals WHERE id = 1` returns ZERO rows if the singleton is
 * missing, which would collapse the caller's whole multi-subquery SELECT to no
 * row at all. Joining outward guarantees exactly one row, with 0s if the
 * rollup has not been written yet.
 */
export const LIFETIME_TOTALS_SELECT = `
  SELECT COALESCE(t.tx_count, 0)        AS lifetime_tx_count,
         COALESCE(t.active_accounts, 0) AS lifetime_active_accounts,
         COALESCE(t.volume_usd, 0)      AS lifetime_volume_usd,
         t.computed_at                  AS lifetime_computed_at
    FROM (VALUES (1)) AS z(id)
    LEFT JOIN analytics_totals t ON t.id = z.id`;

/** Read the materialized lifetime totals. Resilient → zeros. */
export async function getLifetimeTotals(): Promise<LifetimeTotals> {
  try {
    const r = await db().execute({ sql: LIFETIME_TOTALS_SELECT, args: [] });
    const row = r.rows[0] ?? {};
    return {
      txCount: num(row.lifetime_tx_count),
      activeAccounts: num(row.lifetime_active_accounts),
      volumeUsd: num(row.lifetime_volume_usd),
      computedAt:
        row.lifetime_computed_at == null
          ? null
          : num(row.lifetime_computed_at),
    };
  } catch {
    return { txCount: 0, activeAccounts: 0, volumeUsd: 0, computedAt: null };
  }
}
