/**
 * Analytics persistence layer, the cache the on-chain indexer writes and the
 * dashboard reads.
 *
 * Indexing every Talise user's on-chain tx history is far too much work for one
 * HTTP request, so it runs CHUNKED + PERSISTED + RESUMABLE: a singleton cursor
 * (offset into the ordered user list) advances a batch at a time, and each pass
 * upserts per-user aggregates + a bounded recent-transaction feed. The
 * dashboard serves whatever is cached so far (with progress).
 *
 * Three Postgres tables (all idempotent, created by ensureAnalyticsSchema):
 *   • analytics_user_stats, one row per indexed user (aggregates).
 *   • analytics_recent_tx , newest-first recent-transaction feed (PK digest).
 *   • analytics_index_state, singleton (id=1) cursor + run timestamps.
 *
 * Resilient like /api/admin/overview: a failed sub-query yields its zero/empty
 * fallback rather than throwing, so the dashboard always renders. Writes are
 * idempotent ON CONFLICT upserts so re-running a batch never duplicates.
 */

import { db } from "@/lib/db";
import { countUsers } from "@/lib/analytics/users";
import type {
  AnalyticsSnapshot,
  AnalyticsSummary,
  RecentTx,
  UserIndex,
} from "@/lib/analytics/types";

/** Newest N recent transactions the dashboard table serves. */
const RECENT_LIMIT = 60;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length ? s : null;
}

/**
 * Create the three analytics tables + supporting index if they don't exist.
 * Idempotent, safe to call on every request/batch. Seeds the singleton
 * index-state row (id=1) so getCursor/setCursor always have a row to read.
 */
export async function ensureAnalyticsSchema(): Promise<void> {
  await db().execute({
    sql: `CREATE TABLE IF NOT EXISTS analytics_user_stats (
            user_id        INT PRIMARY KEY,
            address        TEXT NOT NULL,
            handle         TEXT,
            tx_count       INT NOT NULL DEFAULT 0,
            volume_usd     DOUBLE PRECISION NOT NULL DEFAULT 0,
            swap_count     INT NOT NULL DEFAULT 0,
            last_active_at BIGINT,
            indexed_at     BIGINT NOT NULL
          )`,
    args: [],
  });

  await db().execute({
    sql: `CREATE TABLE IF NOT EXISTS analytics_recent_tx (
            digest            TEXT PRIMARY KEY,
            user_id           INT,
            address           TEXT,
            handle            TEXT,
            direction         TEXT,
            amount_usd        DOUBLE PRECISION,
            counterparty      TEXT,
            counterparty_name TEXT,
            ts                BIGINT NOT NULL,
            indexed_at        BIGINT NOT NULL
          )`,
    args: [],
  });

  await db().execute({
    sql: `CREATE INDEX IF NOT EXISTS analytics_recent_tx_ts_idx
            ON analytics_recent_tx (ts DESC)`,
    args: [],
  });

  await db().execute({
    sql: `CREATE TABLE IF NOT EXISTS analytics_index_state (
            id           INT PRIMARY KEY DEFAULT 1,
            cursor       INT NOT NULL DEFAULT 0,
            total        INT NOT NULL DEFAULT 0,
            last_run_at  BIGINT,
            full_pass_at BIGINT
          )`,
    args: [],
  });

  // Append-only public metrics checkpoints (the /analytics timeline). One row
  // per completed full pass where the numbers changed; never updated/deleted.
  await db().execute({
    sql: `CREATE TABLE IF NOT EXISTS analytics_snapshots (
            id              BIGSERIAL PRIMARY KEY,
            created_at      BIGINT NOT NULL,
            accounts        INT NOT NULL DEFAULT 0,
            active_accounts INT NOT NULL DEFAULT 0,
            tx_count        INT NOT NULL DEFAULT 0,
            volume_usd      DOUBLE PRECISION NOT NULL DEFAULT 0,
            private_notes   INT NOT NULL DEFAULT 0,
            private_spent   INT NOT NULL DEFAULT 0,
            cheques         INT NOT NULL DEFAULT 0,
            streams         INT NOT NULL DEFAULT 0,
            goals           INT NOT NULL DEFAULT 0,
            waitlist        INT NOT NULL DEFAULT 0
          )`,
    args: [],
  });
  await db().execute({
    sql: `CREATE INDEX IF NOT EXISTS analytics_snapshots_created_idx
            ON analytics_snapshots (created_at DESC)`,
    args: [],
  });

  // Self-heal across environments: an earlier analytics build left
  // analytics_user_stats with a `joined_at BIGINT NOT NULL` column and an
  // obsolete analytics_daily table. CREATE TABLE IF NOT EXISTS won't fix an
  // existing table, so the stale NOT NULL column silently fails every new
  // insert (which omits joined_at). Drop the obsolete column + table, no-ops
  // on a freshly-created schema, repairs a legacy one.
  await db()
    .execute({ sql: `ALTER TABLE analytics_user_stats DROP COLUMN IF EXISTS joined_at`, args: [] })
    .catch(() => {});
  await db()
    .execute({ sql: `DROP TABLE IF EXISTS analytics_daily`, args: [] })
    .catch(() => {});

  // Seed the singleton so getCursor() never returns nothing.
  await db().execute({
    sql: `INSERT INTO analytics_index_state (id, cursor, total)
          VALUES (1, 0, 0)
          ON CONFLICT (id) DO NOTHING`,
    args: [],
  });
}

/**
 * Upsert one user's index pass into analytics_user_stats. Idempotent: a
 * re-index of the same user_id overwrites the prior aggregate rather than
 * inserting a duplicate.
 */
export async function upsertUserStat(s: {
  userId: number;
  address: string;
  handle: string | null;
  idx: UserIndex;
  indexedAt: number;
}): Promise<void> {
  await db().execute({
    sql: `INSERT INTO analytics_user_stats
            (user_id, address, handle, tx_count, volume_usd, swap_count,
             last_active_at, indexed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (user_id) DO UPDATE SET
            address        = EXCLUDED.address,
            handle         = EXCLUDED.handle,
            tx_count       = EXCLUDED.tx_count,
            volume_usd     = EXCLUDED.volume_usd,
            swap_count     = EXCLUDED.swap_count,
            last_active_at = EXCLUDED.last_active_at,
            indexed_at     = EXCLUDED.indexed_at`,
    args: [
      s.userId,
      s.address,
      s.handle,
      s.idx.txCount,
      s.idx.volumeUsd,
      s.idx.swapCount,
      s.idx.lastActiveAt,
      s.indexedAt,
    ],
  });
}

/**
 * Record (upsert) recent-transaction rows keyed by digest. ON CONFLICT(digest)
 * refreshes the row, the same on-chain tx seen across batches stays single,
 * and any newly resolved fields (e.g. a counterparty name) overwrite stale
 * ones. Rows with no digest are skipped (digest is the PK).
 */
export async function recordRecentTxs(
  rows: RecentTx[],
  indexedAt: number
): Promise<void> {
  for (const r of rows) {
    if (!r.digest) continue;
    try {
      await db().execute({
        sql: `INSERT INTO analytics_recent_tx
                (digest, user_id, address, handle, direction, amount_usd,
                 counterparty, counterparty_name, ts, indexed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (digest) DO UPDATE SET
                user_id           = EXCLUDED.user_id,
                address           = EXCLUDED.address,
                handle            = EXCLUDED.handle,
                direction         = EXCLUDED.direction,
                amount_usd        = EXCLUDED.amount_usd,
                counterparty      = EXCLUDED.counterparty,
                counterparty_name = EXCLUDED.counterparty_name,
                ts                = EXCLUDED.ts,
                indexed_at        = EXCLUDED.indexed_at`,
        args: [
          r.digest,
          null,
          r.address,
          r.handle,
          r.direction,
          r.amountUsd,
          r.counterparty,
          r.counterpartyName,
          r.ts,
          indexedAt,
        ],
      });
    } catch {
      // One bad row must not abort the rest of the batch.
    }
  }
}

/**
 * Trim the recent-tx feed to the newest `keep` rows by `ts`, deleting the rest.
 * Bounds table growth across full passes. No-op / resilient on failure.
 */
export async function trimRecentTxs(keep: number): Promise<void> {
  const safeKeep = Math.max(0, Math.floor(Number.isFinite(keep) ? keep : 0));
  try {
    await db().execute({
      sql: `DELETE FROM analytics_recent_tx
             WHERE digest IN (
               SELECT digest FROM analytics_recent_tx
               ORDER BY ts DESC
               OFFSET ?
             )`,
      args: [safeKeep],
    });
  } catch {
    // Trimming is best-effort housekeeping; never break a batch over it.
  }
}

/**
 * Read the singleton index-state row (id=1). Resilient: any failure (incl. a
 * missing table before ensureAnalyticsSchema ran) returns a zeroed cursor so
 * the indexer can start fresh and the dashboard shows "0 indexed".
 */
export async function getCursor(): Promise<{
  cursor: number;
  total: number;
  lastRunAt: number | null;
  fullPassAt: number | null;
}> {
  try {
    const r = await db().execute({
      sql: `SELECT cursor, total, last_run_at, full_pass_at
              FROM analytics_index_state
             WHERE id = 1`,
      args: [],
    });
    const row = r.rows[0];
    if (!row) return { cursor: 0, total: 0, lastRunAt: null, fullPassAt: null };
    return {
      cursor: num(row.cursor),
      total: num(row.total),
      lastRunAt: numOrNull(row.last_run_at),
      fullPassAt: numOrNull(row.full_pass_at),
    };
  } catch {
    return { cursor: 0, total: 0, lastRunAt: null, fullPassAt: null };
  }
}

/**
 * Persist the singleton cursor (id=1). Always stamps last_run_at; only touches
 * full_pass_at when `fullPassAt` is provided (a full pass over all users just
 * completed), passing undefined leaves the existing value intact via COALESCE.
 */
export async function setCursor(v: {
  cursor: number;
  total: number;
  lastRunAt: number;
  fullPassAt?: number | null;
}): Promise<void> {
  await db().execute({
    sql: `INSERT INTO analytics_index_state
            (id, cursor, total, last_run_at, full_pass_at)
          VALUES (1, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET
            cursor       = EXCLUDED.cursor,
            total        = EXCLUDED.total,
            last_run_at  = EXCLUDED.last_run_at,
            full_pass_at = COALESCE(EXCLUDED.full_pass_at,
                                    analytics_index_state.full_pass_at)`,
    args: [
      v.cursor,
      v.total,
      v.lastRunAt,
      v.fullPassAt === undefined ? null : v.fullPassAt,
    ],
  });
}

/**
 * Assemble the full AnalyticsSummary from the cache + live user count.
 *
 * Resilient like /api/admin/overview: each sub-query independently falls back
 * to 0/[] on failure, so a single bad aggregate can't 500 the dashboard. The
 * indexed totals reflect only what's been walked so far (progress is exposed
 * via the `index` block).
 */
export async function getSummary(): Promise<AnalyticsSummary> {
  // Live total accounts (excludes deleted tombstones), the denominator.
  const totalUsers = await countUsers().catch(() => 0);

  // Indexing progress (how many users we've walked) stays a row-count of
  // analytics_user_stats.
  const indexedUsers = await db()
    .execute({ sql: `SELECT COUNT(*) AS n FROM analytics_user_stats`, args: [] })
    .then((r) => num(r.rows[0]?.n))
    .catch(() => 0);

  // Headline totals come from analytics_recent_tx — the digest-keyed, deduped
  // feed — using the SAME query as the public /api/analytics page, so the admin
  // dashboard, the public /analytics page, and the pitch deck all report the
  // identical figures. (SUM over analytics_user_stats both double-counts
  // internal transfers AND reflects only the latest, sometimes source-degraded,
  // per-user snapshot, so it drifted low and diverged from the public numbers.)
  const aggregates = await db()
    .execute({
      sql: `SELECT COUNT(*) AS txs,
                   COALESCE(SUM(amount_usd) FILTER (
                     WHERE direction IN ('sent','swap','withdraw','invest')),0) AS vol
              FROM analytics_recent_tx`,
      args: [],
    })
    .then((r) => ({
      stablecoinVolumeUsd: num(r.rows[0]?.vol),
      transactions: num(r.rows[0]?.txs),
      indexedUsers,
    }))
    .catch(() => ({
      stablecoinVolumeUsd: 0,
      transactions: 0,
      indexedUsers,
    }));

  // Newest-first recent-transaction feed.
  const recent = await db()
    .execute({
      sql: `SELECT digest, address, handle, direction, amount_usd,
                   counterparty, counterparty_name, ts
              FROM analytics_recent_tx
             ORDER BY ts DESC
             LIMIT ${RECENT_LIMIT}`,
      args: [],
    })
    .then((r) =>
      r.rows.map(
        (row): RecentTx => ({
          digest: String(row.digest ?? ""),
          ts: num(row.ts),
          direction: String(row.direction ?? ""),
          amountUsd: numOrNull(row.amount_usd),
          handle: strOrNull(row.handle),
          address: strOrNull(row.address),
          counterparty: strOrNull(row.counterparty),
          counterpartyName: strOrNull(row.counterparty_name),
        })
      )
    )
    .catch((): RecentTx[] => []);

  // Cursor / run timestamps for the progress block.
  const state = await getCursor();

  return {
    totals: {
      users: totalUsers,
      stablecoinVolumeUsd: aggregates.stablecoinVolumeUsd,
      transactions: aggregates.transactions,
    },
    recent,
    index: {
      indexedUsers: aggregates.indexedUsers,
      totalUsers,
      lastRunAt: state.lastRunAt,
      fullPassAt: state.fullPassAt,
    },
  };
}

// ── public checkpoints ─────────────────────────────────────────────────────

/** The aggregate numbers a checkpoint captures (order-independent compare). */
type SnapshotMetrics = Omit<AnalyticsSnapshot, "id" | "createdAt">;

/** Read the current public aggregates (same figures as getPublicAnalytics). */
async function currentSnapshotMetrics(): Promise<SnapshotMetrics> {
  const counts = await db()
    .execute({
      sql: `SELECT
              (SELECT COUNT(*) FROM shield_commitments) AS notes,
              (SELECT COUNT(*) FROM shield_nullifiers)  AS spent,
              (SELECT COUNT(*) FROM cheques)            AS cheques,
              (SELECT COUNT(*) FROM streams)            AS streams,
              (SELECT COUNT(*) FROM savings_goals)      AS goals,
              (SELECT COUNT(*) FROM users)              AS accounts,
              (SELECT COUNT(*) FROM waitlist_signups)   AS waitlist`,
      args: [],
    })
    .then((r) => r.rows[0] ?? {})
    .catch(() => ({}) as Record<string, unknown>);

  const tx = await db()
    .execute({
      sql: `SELECT
              COUNT(*)                AS txcount,
              COUNT(DISTINCT address) AS active,
              COALESCE(SUM(amount_usd) FILTER (
                WHERE direction IN ('sent','swap','withdraw','invest')),0) AS vol
            FROM analytics_recent_tx`,
      args: [],
    })
    .then((r) => r.rows[0] ?? {})
    .catch(() => ({}) as Record<string, unknown>);

  return {
    accounts: num((counts as Record<string, unknown>).accounts),
    activeAccounts: num((tx as Record<string, unknown>).active),
    txCount: num((tx as Record<string, unknown>).txcount),
    volumeUsd: num((tx as Record<string, unknown>).vol),
    privateNotes: num((counts as Record<string, unknown>).notes),
    privateSpent: num((counts as Record<string, unknown>).spent),
    cheques: num((counts as Record<string, unknown>).cheques),
    streams: num((counts as Record<string, unknown>).streams),
    goals: num((counts as Record<string, unknown>).goals),
    waitlist: num((counts as Record<string, unknown>).waitlist),
  };
}

function sameMetrics(a: SnapshotMetrics, b: SnapshotMetrics): boolean {
  return (Object.keys(a) as (keyof SnapshotMetrics)[]).every(
    (k) => a[k] === b[k]
  );
}

/**
 * Append a new public checkpoint iff the numbers changed since the last one.
 * Called at the end of a completed full index pass, so /analytics shows a
 * timeline that grows a step whenever the network actually moved. Best-effort:
 * a failure here never breaks the indexer batch.
 */
export async function recordSnapshotIfChanged(now: number): Promise<void> {
  try {
    const metrics = await currentSnapshotMetrics();
    const last = (await getSnapshots(1))[0];
    // A full AnalyticsSnapshot is a superset of SnapshotMetrics, so it compares
    // directly. Nothing changed since the last checkpoint → don't add one.
    if (last && sameMetrics(metrics, last)) return;
    await db().execute({
      sql: `INSERT INTO analytics_snapshots
              (created_at, accounts, active_accounts, tx_count, volume_usd,
               private_notes, private_spent, cheques, streams, goals, waitlist)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        now,
        metrics.accounts,
        metrics.activeAccounts,
        metrics.txCount,
        metrics.volumeUsd,
        metrics.privateNotes,
        metrics.privateSpent,
        metrics.cheques,
        metrics.streams,
        metrics.goals,
        metrics.waitlist,
      ],
    });
  } catch {
    // Checkpointing is best-effort; never derail a batch over it.
  }
}

/** Read the newest `limit` checkpoints, newest-first. Resilient → [] on error. */
export async function getSnapshots(limit = 90): Promise<AnalyticsSnapshot[]> {
  const cap = Math.max(1, Math.min(500, Math.floor(limit)));
  try {
    const r = await db().execute({
      sql: `SELECT id, created_at, accounts, active_accounts, tx_count,
                   volume_usd, private_notes, private_spent, cheques, streams,
                   goals, waitlist
              FROM analytics_snapshots
             ORDER BY created_at DESC, id DESC
             LIMIT ${cap}`,
      args: [],
    });
    return r.rows.map(
      (row): AnalyticsSnapshot => ({
        id: num(row.id),
        createdAt: num(row.created_at),
        accounts: num(row.accounts),
        activeAccounts: num(row.active_accounts),
        txCount: num(row.tx_count),
        volumeUsd: num(row.volume_usd),
        privateNotes: num(row.private_notes),
        privateSpent: num(row.private_spent),
        cheques: num(row.cheques),
        streams: num(row.streams),
        goals: num(row.goals),
        waitlist: num(row.waitlist),
      })
    );
  } catch {
    return [];
  }
}
