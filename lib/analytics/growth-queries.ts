import "server-only";

import { db } from "@/lib/db";
import { ensureGrowthSchema } from "@/lib/analytics/growth-schema";
import { ensureRevenueSchema } from "@/lib/analytics/growth-revenue";

/**
 * THE DASHBOARD QUERIES.
 *
 * Every metric the product could not measure, as the exact SQL a dashboard
 * runs. They live in the repo rather than in someone's BI tool so they are
 * reviewable, and so the definition of "D7 retention" is one string that can't
 * drift between people.
 *
 * All of them are written for a SMALL connection pool: each is ONE round-trip
 * that aggregates inside Postgres and returns a handful of rows. None of them
 * scans `growth_events` for retention or DAU — those read the
 * `growth_daily_active` rollup, which has one row per user per active day.
 */

// ── D1 / D7 / D30 retention ──────────────────────────────────────────────────

/**
 * D7 RETENTION — the headline number that was impossible before `app_open`.
 *
 * Definition (classic "day-N return", not rolling/bounded):
 *   cohort  = users who signed up on day D (users.created_at, UTC day)
 *   retained= those with an app_open on day D+7 exactly
 *
 * `users.created_at` is the cohort anchor because it is ground truth and
 * predates this pipeline, so cohorts exist for historical users too. The
 * `growth_daily_active` join is an index-only probe of (user_id, day).
 *
 * Swap the `INTERVAL '7 days'` for 1 or 30 to get D1 / D30 — same shape.
 * Use `+ INTERVAL 'N days'` with `>=`/`<` instead of `=` if you want the
 * "returned on or after day N" (unbounded) variant.
 */
export const SQL_D7_RETENTION = `
-- D7 retention by signup cohort day.
WITH cohort AS (
  SELECT
    u.id                                                        AS user_id,
    (to_timestamp(u.created_at / 1000.0) AT TIME ZONE 'UTC')::date AS cohort_day
  FROM users u
  WHERE u.created_at >= $1              -- window start, epoch ms
    AND u.created_at <  $2              -- window end,   epoch ms
),
retained AS (
  SELECT DISTINCT c.user_id, c.cohort_day
  FROM cohort c
  JOIN growth_daily_active a
    ON a.user_id = c.user_id
   AND a.day     = c.cohort_day + INTERVAL '7 days'
)
SELECT
  c.cohort_day,
  COUNT(*)                                        AS cohort_size,
  COUNT(r.user_id)                                AS retained_d7,
  ROUND(100.0 * COUNT(r.user_id) / COUNT(*), 1)   AS d7_pct
FROM cohort c
LEFT JOIN retained r ON r.user_id = c.user_id
-- Only cohorts old enough to HAVE a day 7; younger ones would read as 0%.
WHERE c.cohort_day <= (CURRENT_DATE - INTERVAL '7 days')
GROUP BY c.cohort_day
ORDER BY c.cohort_day DESC;
`.trim();

/** The same shape, parameterised on the day offset (1 / 7 / 30). */
export const SQL_DN_RETENTION = `
WITH cohort AS (
  SELECT u.id AS user_id,
         (to_timestamp(u.created_at / 1000.0) AT TIME ZONE 'UTC')::date AS cohort_day
  FROM users u
  WHERE u.created_at >= $1 AND u.created_at < $2
)
SELECT
  c.cohort_day,
  COUNT(*) AS cohort_size,
  COUNT(a.user_id) AS retained,
  ROUND(100.0 * COUNT(a.user_id) / COUNT(*), 1) AS pct
FROM cohort c
LEFT JOIN growth_daily_active a
  ON a.user_id = c.user_id
 AND a.day     = c.cohort_day + ($3 || ' days')::interval
WHERE c.cohort_day <= (CURRENT_DATE - ($3 || ' days')::interval)
GROUP BY c.cohort_day
ORDER BY c.cohort_day DESC;
`.trim();

// ── K-factor ─────────────────────────────────────────────────────────────────

/**
 * K-FACTOR — invites sent per user × conversion rate of those invites.
 *
 *   K = (invites sent / inviters) × (invited signups / invites sent)
 *     =  invited signups / inviters
 *
 * The three inputs, and where each comes from:
 *   • invites SENT   → `growth_invites` rows with an inviter (one row per
 *                      share-sheet completion; `invite_sent`).
 *   • invites CLICKED→ `growth_invites.click_count`. Clicks land on the
 *                      aggregate row keyed `'code:'||ref_code_hash`, because
 *                      the public invite URL (`/r/<CODE>`) can't carry a
 *                      per-send id — so clicks are attributed to the inviter's
 *                      code, joined back by `ref_code_hash`.
 *   • invited SIGNUPS→ `users.referred_by_user_id`. This is GROUND TRUTH from
 *                      the existing referral system, not a client event, so
 *                      the K numerator cannot be faked by a tampered client.
 *
 * Reported over a window and also as "viral cycle" inputs so a dashboard can
 * show K alongside the click-through and click→signup rates that produce it.
 */
export const SQL_K_FACTOR = `
-- K-factor over a window. $1/$2 are epoch ms bounds.
WITH sent AS (
  SELECT inviter_user_id AS user_id,
         COUNT(*)        AS invites_sent
  FROM growth_invites
  WHERE inviter_user_id IS NOT NULL
    AND created_at >= $1 AND created_at < $2
  GROUP BY inviter_user_id
),
clicks AS (
  -- Click counters live on the per-code aggregate row; map them back to the
  -- inviter via the code hash recorded on their invite_sent rows.
  SELECT i.inviter_user_id AS user_id,
         SUM(agg.click_count) AS clicks
  FROM (SELECT DISTINCT inviter_user_id, ref_code_hash
          FROM growth_invites
         WHERE inviter_user_id IS NOT NULL AND ref_code_hash IS NOT NULL) i
  JOIN growth_invites agg
    ON agg.ref_code_hash = i.ref_code_hash
   AND agg.invite_id = 'code:' || i.ref_code_hash
  GROUP BY i.inviter_user_id
),
signups AS (
  -- Ground truth: accounts created in the window that were referred.
  SELECT u.referred_by_user_id AS user_id,
         COUNT(*)              AS invited_signups
  FROM users u
  WHERE u.referred_by_user_id IS NOT NULL
    AND u.created_at >= $1 AND u.created_at < $2
  GROUP BY u.referred_by_user_id
)
SELECT
  COUNT(DISTINCT s.user_id)                                        AS inviters,
  COALESCE(SUM(s.invites_sent), 0)                                 AS invites_sent,
  COALESCE(SUM(c.clicks), 0)                                       AS invite_clicks,
  COALESCE(SUM(g.invited_signups), 0)                              AS invited_signups,
  -- invites per inviter
  ROUND(COALESCE(SUM(s.invites_sent), 0)::numeric
        / NULLIF(COUNT(DISTINCT s.user_id), 0), 2)                 AS invites_per_inviter,
  -- click-through rate on invites
  ROUND(100.0 * COALESCE(SUM(c.clicks), 0)
        / NULLIF(COALESCE(SUM(s.invites_sent), 0), 0), 1)          AS click_rate_pct,
  -- click -> signup conversion
  ROUND(100.0 * COALESCE(SUM(g.invited_signups), 0)
        / NULLIF(COALESCE(SUM(c.clicks), 0), 0), 1)                AS click_to_signup_pct,
  -- K = invited signups per inviter
  ROUND(COALESCE(SUM(g.invited_signups), 0)::numeric
        / NULLIF(COUNT(DISTINCT s.user_id), 0), 3)                 AS k_factor
FROM sent s
FULL OUTER JOIN clicks  c ON c.user_id = s.user_id
FULL OUTER JOIN signups g ON g.user_id = COALESCE(s.user_id, c.user_id);
`.trim();

// ── DAU / WAU / MAU ──────────────────────────────────────────────────────────

export const SQL_DAU_WAU_MAU = `
SELECT
  COUNT(DISTINCT CASE WHEN day  = CURRENT_DATE                         THEN user_id END) AS dau,
  COUNT(DISTINCT CASE WHEN day >= CURRENT_DATE - INTERVAL '6 days'     THEN user_id END) AS wau,
  COUNT(DISTINCT CASE WHEN day >= CURRENT_DATE - INTERVAL '29 days'    THEN user_id END) AS mau
FROM growth_daily_active
WHERE day >= CURRENT_DATE - INTERVAL '29 days';
`.trim();

/** DAU by platform by day — the iOS/Android/web split that was invisible. */
export const SQL_DAU_BY_PLATFORM = `
SELECT day, platform, COUNT(DISTINCT user_id) AS dau
FROM growth_daily_active
WHERE day >= CURRENT_DATE - ($1 || ' days')::interval
GROUP BY day, platform
ORDER BY day DESC, platform;
`.trim();

// ── Funnels ──────────────────────────────────────────────────────────────────

/** Signup funnel by platform: started → auth → account → onboarded. */
export const SQL_SIGNUP_FUNNEL = `
SELECT
  platform,
  COUNT(DISTINCT CASE WHEN event = 'signup_started'        THEN COALESCE(anon_id, user_id::text) END) AS started,
  COUNT(DISTINCT CASE WHEN event = 'signup_auth_completed' THEN COALESCE(anon_id, user_id::text) END) AS authed,
  COUNT(DISTINCT CASE WHEN event = 'signup_completed'      THEN user_id::text END)                    AS accounts,
  COUNT(DISTINCT CASE WHEN event = 'onboarding_completed'  THEN user_id::text END)                    AS onboarded
FROM growth_events
WHERE ts >= $1 AND ts < $2
GROUP BY platform
ORDER BY started DESC;
`.trim();

/** Per-step onboarding drop-off — where people actually quit. */
export const SQL_ONBOARDING_DROPOFF = `
SELECT platform, step, COUNT(DISTINCT COALESCE(anon_id, user_id::text)) AS reached
FROM growth_events
WHERE event = 'onboarding_step' AND ts >= $1 AND ts < $2
GROUP BY platform, step
ORDER BY platform, reached DESC;
`.trim();

/**
 * ACTIVATION — signup → funded → first send, with medians.
 * Reads `growth_user_firsts`, so it's a single sequential scan of one narrow
 * table no matter how many events exist.
 */
export const SQL_ACTIVATION = `
SELECT
  COUNT(*)                                                          AS signups,
  COUNT(funded_at)                                                  AS funded,
  COUNT(first_send_at)                                              AS sent,
  ROUND(100.0 * COUNT(funded_at)     / NULLIF(COUNT(*), 0), 1)      AS funded_pct,
  ROUND(100.0 * COUNT(first_send_at) / NULLIF(COUNT(*), 0), 1)      AS sent_pct,
  -- hours from signup to first money in / first send
  ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (
      ORDER BY (funded_at - signup_completed_at) / 3600000.0))::numeric, 1)     AS median_hours_to_funded,
  ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (
      ORDER BY (first_send_at - signup_completed_at) / 3600000.0))::numeric, 1) AS median_hours_to_first_send
FROM growth_user_firsts
WHERE signup_completed_at >= $1 AND signup_completed_at < $2;
`.trim();

// ── Acquisition ──────────────────────────────────────────────────────────────

/** Signups and activation by acquisition channel — the attribution payoff. */
export const SQL_ACQUISITION = `
SELECT
  COALESCE(a.source, 'unknown')                                       AS source,
  a.campaign,
  COUNT(*)                                                            AS signups,
  COUNT(f.funded_at)                                                  AS funded,
  COUNT(f.first_send_at)                                              AS activated,
  ROUND(100.0 * COUNT(f.first_send_at) / NULLIF(COUNT(*), 0), 1)      AS activation_pct
FROM users u
LEFT JOIN growth_user_attribution a ON a.user_id = u.id
LEFT JOIN growth_user_firsts      f ON f.user_id = u.id
WHERE u.created_at >= $1 AND u.created_at < $2
GROUP BY COALESCE(a.source, 'unknown'), a.campaign
ORDER BY signups DESC;
`.trim();

// ── Revenue ──────────────────────────────────────────────────────────────────

/** Revenue by source and day, separating measured from schedule-derived. */
export const SQL_REVENUE_BY_DAY = `
SELECT
  (to_timestamp(occurred_at / 1000.0) AT TIME ZONE 'UTC')::date AS day,
  source,
  derived,
  ROUND(SUM(fee_usd)::numeric, 2)   AS fee_usd,
  ROUND(SUM(gross_usd)::numeric, 2) AS gross_usd,
  COUNT(*)                          AS n
FROM revenue_events
WHERE occurred_at >= $1 AND occurred_at < $2
GROUP BY 1, source, derived
ORDER BY 1 DESC, fee_usd DESC;
`.trim();

/** Push reachability + notification CTR. */
export const SQL_PUSH_PERFORMANCE = `
SELECT
  platform,
  COUNT(DISTINCT CASE WHEN event = 'push_permission_granted' THEN user_id END) AS granted,
  COUNT(DISTINCT CASE WHEN event = 'push_permission_denied'  THEN user_id END) AS denied,
  COUNT(*) FILTER (WHERE event = 'notification_opened')                        AS opens
FROM growth_events
WHERE ts >= $1 AND ts < $2
  AND event IN ('push_permission_granted', 'push_permission_denied', 'notification_opened')
GROUP BY platform;
`.trim();

// ── Runners ──────────────────────────────────────────────────────────────────

/**
 * Run one of the queries above. `$n` placeholders are used verbatim (postgres
 * numbering) — the db adapter rewrites `?` but leaves `$n` untouched, so these
 * strings work as written and stay copy-pasteable into psql.
 */
async function run(sql: string, args: unknown[]): Promise<Array<Record<string, unknown>>> {
  await ensureGrowthSchema();
  const r = await db().execute({ sql, args });
  return r.rows as Array<Record<string, unknown>>;
}

export function d7Retention(fromMs: number, toMs: number) {
  return run(SQL_D7_RETENTION, [fromMs, toMs]);
}

export function dnRetention(fromMs: number, toMs: number, days: 1 | 7 | 30) {
  return run(SQL_DN_RETENTION, [fromMs, toMs, String(days)]);
}

export function kFactor(fromMs: number, toMs: number) {
  return run(SQL_K_FACTOR, [fromMs, toMs]);
}

export function dauWauMau() {
  return run(SQL_DAU_WAU_MAU, []);
}

export function activation(fromMs: number, toMs: number) {
  return run(SQL_ACTIVATION, [fromMs, toMs]);
}

export function acquisition(fromMs: number, toMs: number) {
  return run(SQL_ACQUISITION, [fromMs, toMs]);
}

export function signupFunnel(fromMs: number, toMs: number) {
  return run(SQL_SIGNUP_FUNNEL, [fromMs, toMs]);
}

/**
 * Runners for the remaining four constants.
 *
 * Every SQL string in this module now has exactly one runner, so the read route
 * cannot answer a metric with a hand-written variant of a query that also lives
 * here — which is the whole reason these definitions are in the repo.
 */
export function onboardingDropoff(fromMs: number, toMs: number) {
  return run(SQL_ONBOARDING_DROPOFF, [fromMs, toMs]);
}

/** `days` is interpolated as a bound parameter into `($1 || ' days')::interval`. */
export function dauByPlatform(days: number) {
  const n = Math.max(1, Math.min(365, Math.floor(days)));
  return run(SQL_DAU_BY_PLATFORM, [String(n)]);
}

export function pushPerformance(fromMs: number, toMs: number) {
  return run(SQL_PUSH_PERFORMANCE, [fromMs, toMs]);
}

/**
 * `revenue_events` is created by `ensureRevenueSchema()`, not by the growth
 * schema pass, so this runner bootstraps its own table rather than reading one
 * that may not exist yet on a fresh database.
 */
export async function revenueByDay(fromMs: number, toMs: number) {
  await ensureRevenueSchema();
  const r = await db().execute({ sql: SQL_REVENUE_BY_DAY, args: [fromMs, toMs] });
  return r.rows as Array<Record<string, unknown>>;
}
