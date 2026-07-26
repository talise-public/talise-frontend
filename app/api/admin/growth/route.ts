import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { requireAdminApi } from "@/lib/admin-auth";
import { ensureAnalyticsSchema, getSnapshots } from "@/lib/analytics/store";
import type { AnalyticsSnapshot } from "@/lib/analytics/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/growth — the growth question set, answered from data that
 * already exists. Read-only, admin-gated, no new instrumentation.
 *
 * ## Single-query discipline
 *
 * Production Postgres runs a small pool (max 8) shared with the whole app, and
 * this dashboard answers ~40 questions. Asking them one query at a time is how
 * you get timeout-zeros: the tail queries sit in the pool queue longer than
 * their own budget and silently resolve to 0, so the page renders confident
 * wrong numbers. So every question is folded into one of SIX round trips, each
 * shaped to carry many metrics at once:
 *
 *   1. `scalars`     — one SELECT whose columns are scalar subqueries.
 *   2. `daily`       — LONG FORMAT: UNION ALL of per-day GROUP BYs, tagged with
 *                      a `series` label. One query, every timeseries.
 *   3. `breakdowns`  — LONG FORMAT: UNION ALL of dimension GROUP BYs, tagged
 *                      with a `grp` label. One query, every cut.
 *   4. `lifecycle`   — UNION ALL of per-stage percentile aggregates.
 *   5. `topUsers`    — one grouped join, LIMIT-ed.
 *   6. `snapshots`   — the analytics_snapshots timeline.
 *
 * Those six are then run through a concurrency limiter of 3, so this route
 * never holds more than three connections and leaves headroom for real traffic.
 *
 * ## growth_events
 *
 * DAU / retention / K-factor / UTM need an event pipeline that a separate
 * workstream owns. This route FEATURE-DETECTS `growth_events` (and its column
 * names) as one scalar column in query 1, and only if the table is present with
 * usable columns does it issue a SEVENTH query. When the table is absent the
 * response carries `growthEvents: null` and the UI shows those panels as
 * pending rather than failing.
 *
 * ## Correctness notes
 *
 * - Every `*_at` column in this schema is BIGINT epoch milliseconds, so day
 *   buckets are `to_timestamp(x / 1000.0) AT TIME ZONE 'UTC'`.
 * - Deleted accounts are tombstones (`users.deleted_at` set, identifying
 *   columns redacted), so every user-facing count filters `deleted_at IS NULL`.
 *   Without that filter signups and conversion rates both read high.
 * - `transfers.user_id` / `linq_offramps.user_id` are TEXT while `users.id` is
 *   INTEGER; any join across them must cast.
 * - `tx_history.amount` is TEXT, so money actions are COUNTED, never summed.
 *   USD sums come from `analytics_tx_ledger.amount_usd` (DOUBLE PRECISION) and
 *   `transfers.usdsui_amount` (NUMERIC, cast), which are real numerics.
 * - Only tables in `ensureSchema()`'s DDL are referenced, because one missing
 *   table would fail an entire UNION and blank every series in it.
 * - Per-user lifetime volume comes from `analytics_tx_ledger` (durable, one row
 *   per digest for all time), never from the trimmed `analytics_recent_tx` feed.
 */

/**
 * Generous per-query budget. Its job is to stop an infinite hang (a stale
 * pooled connection that never settles), not to be the expected latency —
 * measured from dispatch, so it has to cover queue wait plus execution.
 */
const QUERY_TIMEOUT_MS = 20_000;

/** Days of daily-series history returned. */
const WINDOW_DAYS = 90;

/** Rows in the top-accounts table. */
const TOP_USERS = 25;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Directions that count as value moved (mirrors the public volume filter). */
const VOLUME_FILTER = `l.direction IN ('sent','swap','withdraw','invest')`;

/** BIGINT epoch-ms column → 'YYYY-MM-DD' UTC day bucket. */
const day = (col: string) =>
  `to_char(to_timestamp(${col} / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

async function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), QUERY_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Row = Record<string, unknown>;

function rows(sql: string, args: ReadonlyArray<unknown> = []): Promise<Row[]> {
  return withTimeout(
    (async () => {
      const r = await db().execute({ sql, args });
      return r.rows as Row[];
    })(),
    [] as Row[]
  );
}

function row1(sql: string, args: ReadonlyArray<unknown> = []): Promise<Row> {
  return withTimeout(
    (async () => {
      const r = await db().execute({ sql, args });
      return (r.rows[0] ?? {}) as Row;
    })(),
    {} as Row
  );
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const nOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/**
 * Run thunks with bounded concurrency, preserving order. Three at a time keeps
 * this route to three pooled connections out of eight.
 */
async function runLimited<T>(thunks: Array<() => Promise<T>>, limit = 3): Promise<T[]> {
  const out = new Array<T>(thunks.length);
  let next = 0;
  async function worker() {
    while (next < thunks.length) {
      const i = next++;
      out[i] = await thunks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker));
  return out;
}

// ── response shape ─────────────────────────────────────────────────────────

export type GrowthSeriesPoint = { series: string; day: string; n: number; v: number };
export type GrowthBreakdown = { grp: string; key: string; n: number; v: number };
export type GrowthStage = {
  stage: string;
  n: number;
  p50Ms: number | null;
  p90Ms: number | null;
  avgMs: number | null;
};
export type GrowthTopUser = {
  userId: number;
  handle: string | null;
  country: string | null;
  accountType: string;
  kycTier: number;
  createdAt: number;
  volumeUsd: number;
  txCount: number;
  lastActiveAt: number | null;
};
export type GrowthEventsPanel = {
  columns: string[];
  dau: Array<{ day: string; users: number; events: number }>;
  topEvents: Array<{ key: string; n: number }>;
};

export type GrowthResponse = {
  generatedAt: number;
  windowDays: number;
  funnel: {
    waitlistTotal: number;
    waitlistConfirmed: number;
    waitlistConverted: number;
    waitlistHandlesClaimed: number;
    usersTotal: number;
    usersNew24h: number;
    usersNew7d: number;
    usersNew30d: number;
    handlesClaimed: number;
    everTransacted: number;
    pushReachableUsers: number;
    pushTokens: number;
  };
  transfers: {
    total: number;
    settled: number;
    failed: number;
    parked: number;
    inFlight: number;
    linqTotal: number;
  };
  timeToFirstTx: {
    users: number;
    p50Ms: number | null;
    p90Ms: number | null;
    avgMs: number | null;
    within1h: number;
    within24h: number;
    within7d: number;
  };
  daily: GrowthSeriesPoint[];
  breakdowns: GrowthBreakdown[];
  lifecycle: GrowthStage[];
  topUsers: GrowthTopUser[];
  snapshots: AnalyticsSnapshot[];
  /** null when the growth_events pipeline has not landed yet. */
  growthEvents: GrowthEventsPanel | null;
};

// ── the six queries ────────────────────────────────────────────────────────

/**
 * Query 1 — every scalar the dashboard needs, as columns of one SELECT.
 *
 * `growth_event_columns` is the feature probe: string_agg over
 * information_schema yields NULL when the table does not exist, so detection
 * costs no extra round trip.
 */
const SCALARS_SQL = `
  SELECT
    (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) AS users_total,
    (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND created_at >= ?) AS users_24h,
    (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND created_at >= ?) AS users_7d,
    (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND created_at >= ?) AS users_30d,
    (SELECT COUNT(*) FROM users u
      WHERE u.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM tx_history t WHERE t.user_id = u.id)) AS ever_transacted,
    (SELECT COUNT(*) FROM users
      WHERE deleted_at IS NULL AND talise_username IS NOT NULL) AS handles_claimed,
    (SELECT COUNT(DISTINCT user_id) FROM device_token) AS push_users,
    (SELECT COUNT(*) FROM device_token) AS push_tokens,
    (SELECT COUNT(*) FROM waitlist_signups) AS waitlist_total,
    (SELECT COUNT(*) FROM waitlist_signups WHERE confirmation_sent = true) AS waitlist_confirmed,
    (SELECT COUNT(*) FROM waitlist_signups WHERE claimed_handle IS NOT NULL) AS waitlist_handles,
    (SELECT COUNT(*) FROM waitlist_signups w
      WHERE EXISTS (SELECT 1 FROM users u
                     WHERE u.deleted_at IS NULL
                       AND LOWER(u.email) = LOWER(w.email))) AS waitlist_converted,
    (SELECT COUNT(*) FROM transfers) AS transfers_total,
    (SELECT COUNT(*) FROM transfers WHERE settled_at IS NOT NULL) AS transfers_settled,
    (SELECT COUNT(*) FROM transfers WHERE failed_at IS NOT NULL) AS transfers_failed,
    (SELECT COUNT(*) FROM transfers WHERE parked_funds = true) AS transfers_parked,
    (SELECT COUNT(*) FROM transfers
      WHERE state NOT IN ('settled','failed','refunded')) AS transfers_inflight,
    (SELECT COUNT(*) FROM linq_offramps) AS linq_total,
    (SELECT string_agg(column_name, ',' ORDER BY ordinal_position)
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'growth_events') AS growth_event_columns`;

/**
 * Query 1b — time to first transaction.
 *
 * Defined as `MIN(rewards_events.created_at) - users.created_at`: a rewards
 * event is written for every earning money action, so its first occurrence is
 * the earliest durable per-user proof of activity in this schema. Negative
 * deltas (an event stamped before the account row) are excluded as clock/backfill
 * artefacts rather than reported as instant activation. Users with no event at
 * all are simply absent from the denominator — this measures how fast activating
 * users activate, NOT what share of signups activate (that is `everTransacted`).
 */
const TTFT_SQL = `
  WITH first_evt AS (
    SELECT u.id, MIN(r.created_at) - u.created_at AS delta_ms
      FROM users u
      JOIN rewards_events r ON r.user_id = u.id
     WHERE u.deleted_at IS NULL
     GROUP BY u.id, u.created_at
  )
  SELECT COUNT(*) AS n,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY delta_ms) AS p50,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY delta_ms) AS p90,
         AVG(delta_ms) AS avg_ms,
         COUNT(*) FILTER (WHERE delta_ms <=     3600000) AS within_1h,
         COUNT(*) FILTER (WHERE delta_ms <=    86400000) AS within_24h,
         COUNT(*) FILTER (WHERE delta_ms <=   604800000) AS within_7d
    FROM first_evt
   WHERE delta_ms >= 0`;

/**
 * Query 2 — every daily series in ONE round trip, long format.
 *
 * `v` carries a money value where one exists and 0 otherwise; every branch
 * casts to double precision so the UNION's column types line up (NUMERIC
 * columns would otherwise come back as strings from some branches only).
 */
const DAILY_SQL = `
    SELECT 'signups' AS series, ${day("created_at")} AS d,
           COUNT(*) AS n, 0::double precision AS v
      FROM users WHERE deleted_at IS NULL AND created_at >= ? GROUP BY 2
  UNION ALL
    SELECT 'waitlist', ${day("created_at")}, COUNT(*), 0::double precision
      FROM waitlist_signups WHERE created_at >= ? GROUP BY 2
  UNION ALL
    SELECT 'action:' || kind, ${day("created_at")}, COUNT(*), 0::double precision
      FROM tx_history WHERE created_at >= ? GROUP BY 1, 2
  UNION ALL
    SELECT 'transfers', ${day("created_at")}, COUNT(*),
           COALESCE(SUM(usdsui_amount), 0)::double precision
      FROM transfers WHERE created_at >= ? GROUP BY 2
  UNION ALL
    SELECT 'transfers_failed', ${day("failed_at")}, COUNT(*), 0::double precision
      FROM transfers WHERE failed_at IS NOT NULL AND failed_at >= ? GROUP BY 2
  UNION ALL
    SELECT 'rewards', ${day("created_at")}, COUNT(*),
           COALESCE(SUM(points), 0)::double precision
      FROM rewards_events WHERE created_at >= ? GROUP BY 2
  UNION ALL
    SELECT 'onchain', ${day("l.ts")}, COUNT(*),
           COALESCE(SUM(l.amount_usd) FILTER (WHERE ${VOLUME_FILTER}), 0)::double precision
      FROM analytics_tx_ledger l WHERE l.ts >= ? GROUP BY 2
  ORDER BY 1, 2`;

/**
 * Query 3 — every dimensional cut in ONE round trip, long format.
 *
 * The corridor key is `SRC-DST` (three-letter codes, so the client can split on
 * the hyphen). Per-user lifetime volume is banded here rather than returned
 * per user, so the distribution ships as a handful of rows.
 */
const BREAKDOWNS_SQL = `
  WITH per_user AS (
    SELECT u.id,
           COALESCE(SUM(l.amount_usd) FILTER (WHERE ${VOLUME_FILTER}), 0) AS vol
      FROM users u
      LEFT JOIN analytics_tx_ledger l ON l.address = u.sui_address
     WHERE u.deleted_at IS NULL
     GROUP BY u.id
  )
    SELECT 'country' AS grp, COALESCE(NULLIF(country, ''), 'unknown') AS key,
           COUNT(*) AS n, 0::double precision AS v
      FROM users WHERE deleted_at IS NULL GROUP BY 2
  UNION ALL
    SELECT 'account_type', COALESCE(NULLIF(account_type, ''), 'personal'),
           COUNT(*), 0::double precision
      FROM users WHERE deleted_at IS NULL GROUP BY 2
  UNION ALL
    SELECT 'kyc_tier', 'T' || COALESCE(kyc_tier, 0)::text,
           COUNT(*), 0::double precision
      FROM users WHERE deleted_at IS NULL GROUP BY 2
  UNION ALL
    SELECT 'corridor', source_currency || '-' || dest_currency, COUNT(*),
           COALESCE(SUM(usdsui_amount), 0)::double precision
      FROM transfers GROUP BY 2
  UNION ALL
    SELECT 'transfer_state', state, COUNT(*), 0::double precision
      FROM transfers GROUP BY 2
  UNION ALL
    SELECT 'transfer_kind', kind, COUNT(*),
           COALESCE(SUM(usdsui_amount), 0)::double precision
      FROM transfers GROUP BY 2
  UNION ALL
    SELECT 'linq_status', status, COUNT(*),
           COALESCE(SUM(amount_usdsui), 0)::double precision
      FROM linq_offramps GROUP BY 2
  UNION ALL
    SELECT 'action', kind, COUNT(*), 0::double precision
      FROM tx_history GROUP BY 2
  UNION ALL
    SELECT 'reward_kind', kind, COUNT(*),
           COALESCE(SUM(points), 0)::double precision
      FROM rewards_events GROUP BY 2
  UNION ALL
    SELECT 'volume_band',
           CASE WHEN vol <= 0        THEN '0 none'
                WHEN vol < 10        THEN '1 under 10'
                WHEN vol < 100       THEN '2 10 to 100'
                WHEN vol < 1000      THEN '3 100 to 1k'
                WHEN vol < 10000     THEN '4 1k to 10k'
                ELSE                      '5 over 10k' END,
           COUNT(*), COALESCE(SUM(vol), 0)::double precision
      FROM per_user GROUP BY 2
  ORDER BY 1, 3 DESC`;

/**
 * Query 4 — the full transfer lifecycle, stage by stage.
 *
 * Each stage measures only rows that actually reached it, and guards against a
 * non-monotonic pair of stamps (`>=`) so a clock artefact cannot produce a
 * negative "latency" that then drags the average below zero.
 */
const LIFECYCLE_SQL = `
    SELECT 'quote to debit' AS stage, COUNT(*) AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY debited_at - created_at) AS p50,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY debited_at - created_at) AS p90,
           AVG(debited_at - created_at) AS avg_ms
      FROM transfers WHERE debited_at IS NOT NULL AND debited_at >= created_at
  UNION ALL
    SELECT 'debit to on-chain', COUNT(*),
           percentile_cont(0.5) WITHIN GROUP (ORDER BY onchain_settled_at - debited_at),
           percentile_cont(0.9) WITHIN GROUP (ORDER BY onchain_settled_at - debited_at),
           AVG(onchain_settled_at - debited_at)
      FROM transfers
     WHERE onchain_settled_at IS NOT NULL AND debited_at IS NOT NULL
       AND onchain_settled_at >= debited_at
  UNION ALL
    SELECT 'on-chain to fiat out', COUNT(*),
           percentile_cont(0.5) WITHIN GROUP (ORDER BY settled_at - onchain_settled_at),
           percentile_cont(0.9) WITHIN GROUP (ORDER BY settled_at - onchain_settled_at),
           AVG(settled_at - onchain_settled_at)
      FROM transfers
     WHERE settled_at IS NOT NULL AND onchain_settled_at IS NOT NULL
       AND settled_at >= onchain_settled_at
  UNION ALL
    SELECT 'end to end', COUNT(*),
           percentile_cont(0.5) WITHIN GROUP (ORDER BY settled_at - created_at),
           percentile_cont(0.9) WITHIN GROUP (ORDER BY settled_at - created_at),
           AVG(settled_at - created_at)
      FROM transfers WHERE settled_at IS NOT NULL AND settled_at >= created_at
  UNION ALL
    SELECT 'time to failure', COUNT(*),
           percentile_cont(0.5) WITHIN GROUP (ORDER BY failed_at - created_at),
           percentile_cont(0.9) WITHIN GROUP (ORDER BY failed_at - created_at),
           AVG(failed_at - created_at)
      FROM transfers WHERE failed_at IS NOT NULL AND failed_at >= created_at`;

/**
 * Query 5 — accounts ranked by lifetime on-chain volume.
 *
 * Joined on address against the durable ledger, so this is lifetime truth and
 * not a rolling window. `email` is deliberately not selected: the handle plus
 * country identifies an account well enough for a growth read, and a new
 * surface should carry the least PII that still answers the question.
 */
const TOP_USERS_SQL = `
  SELECT u.id                                   AS id,
         u.talise_username                      AS handle,
         u.country                              AS country,
         COALESCE(u.account_type, 'personal')   AS account_type,
         COALESCE(u.kyc_tier, 0)                AS kyc_tier,
         u.created_at                           AS created_at,
         COALESCE(SUM(l.amount_usd) FILTER (WHERE ${VOLUME_FILTER}), 0) AS vol,
         COUNT(l.digest)                        AS txs,
         MAX(l.ts)                              AS last_active_at
    FROM users u
    LEFT JOIN analytics_tx_ledger l ON l.address = u.sui_address
   WHERE u.deleted_at IS NULL
   GROUP BY u.id, u.talise_username, u.country, u.account_type, u.kyc_tier,
            u.created_at
   ORDER BY vol DESC, txs DESC
   LIMIT ${TOP_USERS}`;

/**
 * Query 7 (conditional) — the growth_events panels.
 *
 * Only issued when query 1 reported the table with a usable shape. Column names
 * are resolved from the detected set rather than assumed, because the pipeline
 * that creates the table is owned elsewhere: the first matching candidate wins
 * and the identifiers are double-quoted, so nothing user-supplied reaches SQL.
 */
function growthEventsSql(tsCol: string, userCol: string, nameCol: string | null): string {
  const eventKey = nameCol ? `COALESCE(NULLIF("${nameCol}", ''), 'unknown')` : `'event'`;
  return `
      SELECT 'dau' AS grp, ${day(`"${tsCol}"`)} AS key,
             COUNT(DISTINCT "${userCol}") AS a, COUNT(*) AS b
        FROM growth_events WHERE "${tsCol}" >= ? GROUP BY 2
    UNION ALL
      SELECT 'event', ${eventKey}, COUNT(*), 0
        FROM growth_events WHERE "${tsCol}" >= ? GROUP BY 2
      ORDER BY 1, 2`;
}

/** Candidate column names, most likely first. */
const TS_CANDIDATES = ["created_at", "occurred_at", "ts", "event_at", "at"];
const USER_CANDIDATES = ["user_id", "userid", "account_id", "anon_id", "session_id"];
const NAME_CANDIDATES = ["name", "event", "event_name", "kind", "type"];

const pick = (cols: string[], candidates: string[]): string | null =>
  candidates.find((c) => cols.includes(c)) ?? null;

// ── handler ────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;

  await ensureSchema().catch(() => {});
  // Creates analytics_tx_ledger / analytics_totals if this database has never
  // run an indexer batch, so the volume panels read 0 instead of erroring.
  await ensureAnalyticsSchema().catch(() => {});

  const now = Date.now();
  const since = now - WINDOW_DAYS * DAY_MS;

  const [scalars, ttft, dailyRows, breakdownRows, lifecycleRows, topRows, snapshots] =
    await runLimited<Row | Row[] | AnalyticsSnapshot[]>([
      () => row1(SCALARS_SQL, [now - DAY_MS, now - 7 * DAY_MS, now - 30 * DAY_MS]),
      () => row1(TTFT_SQL),
      // Seven `?`s, one per UNION branch. The adapter numbers placeholders
      // sequentially and cannot reuse one, so `since` is passed per branch.
      () => rows(DAILY_SQL, [since, since, since, since, since, since, since]),
      () => rows(BREAKDOWNS_SQL),
      () => rows(LIFECYCLE_SQL),
      () => rows(TOP_USERS_SQL),
      () => getSnapshots(WINDOW_DAYS).catch((): AnalyticsSnapshot[] => []),
    ]) as [Row, Row, Row[], Row[], Row[], Row[], AnalyticsSnapshot[]];

  // ── growth_events, only if it exists with a usable shape ────────────────
  let growthEvents: GrowthEventsPanel | null = null;
  const detected = s(scalars.growth_event_columns);
  if (detected) {
    const cols = detected.split(",").map((c) => c.trim()).filter(Boolean);
    const tsCol = pick(cols, TS_CANDIDATES);
    const userCol = pick(cols, USER_CANDIDATES);
    const nameCol = pick(cols, NAME_CANDIDATES);
    if (tsCol && userCol) {
      const evRows = await rows(growthEventsSql(tsCol, userCol, nameCol), [since, since]);
      growthEvents = {
        columns: cols,
        dau: evRows
          .filter((r) => s(r.grp) === "dau")
          .map((r) => ({ day: s(r.key), users: n(r.a), events: n(r.b) })),
        topEvents: evRows
          .filter((r) => s(r.grp) === "event")
          .map((r) => ({ key: s(r.key), n: n(r.a) }))
          .sort((a, b) => b.n - a.n)
          .slice(0, 20),
      };
    } else {
      // Table exists but we cannot read it safely — say so instead of guessing.
      growthEvents = { columns: cols, dau: [], topEvents: [] };
    }
  }

  const body: GrowthResponse = {
    generatedAt: now,
    windowDays: WINDOW_DAYS,
    funnel: {
      waitlistTotal: n(scalars.waitlist_total),
      waitlistConfirmed: n(scalars.waitlist_confirmed),
      waitlistConverted: n(scalars.waitlist_converted),
      waitlistHandlesClaimed: n(scalars.waitlist_handles),
      usersTotal: n(scalars.users_total),
      usersNew24h: n(scalars.users_24h),
      usersNew7d: n(scalars.users_7d),
      usersNew30d: n(scalars.users_30d),
      handlesClaimed: n(scalars.handles_claimed),
      everTransacted: n(scalars.ever_transacted),
      pushReachableUsers: n(scalars.push_users),
      pushTokens: n(scalars.push_tokens),
    },
    transfers: {
      total: n(scalars.transfers_total),
      settled: n(scalars.transfers_settled),
      failed: n(scalars.transfers_failed),
      parked: n(scalars.transfers_parked),
      inFlight: n(scalars.transfers_inflight),
      linqTotal: n(scalars.linq_total),
    },
    timeToFirstTx: {
      users: n(ttft.n),
      p50Ms: nOrNull(ttft.p50),
      p90Ms: nOrNull(ttft.p90),
      avgMs: nOrNull(ttft.avg_ms),
      within1h: n(ttft.within_1h),
      within24h: n(ttft.within_24h),
      within7d: n(ttft.within_7d),
    },
    daily: dailyRows.map((r) => ({
      series: s(r.series),
      day: s(r.d),
      n: n(r.n),
      v: n(r.v),
    })),
    breakdowns: breakdownRows.map((r) => ({
      grp: s(r.grp),
      key: s(r.key),
      n: n(r.n),
      v: n(r.v),
    })),
    lifecycle: lifecycleRows.map((r) => ({
      stage: s(r.stage),
      n: n(r.n),
      p50Ms: nOrNull(r.p50),
      p90Ms: nOrNull(r.p90),
      avgMs: nOrNull(r.avg_ms),
    })),
    topUsers: topRows.map((r) => ({
      userId: n(r.id),
      handle: r.handle == null ? null : s(r.handle),
      country: r.country == null ? null : s(r.country),
      accountType: s(r.account_type),
      kycTier: n(r.kyc_tier),
      createdAt: n(r.created_at),
      volumeUsd: n(r.vol),
      txCount: n(r.txs),
      lastActiveAt: nOrNull(r.last_active_at),
    })),
    snapshots,
    growthEvents,
  };

  return NextResponse.json(body);
}
