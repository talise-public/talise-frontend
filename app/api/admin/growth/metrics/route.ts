import { NextResponse } from "next/server";

import { requireAdminApi } from "@/lib/admin-auth";
import {
  acquisition,
  activation,
  dauByPlatform,
  dauWauMau,
  dnRetention,
  kFactor,
  onboardingDropoff,
  pushPerformance,
  revenueByDay,
  signupFunnel,
} from "@/lib/analytics/growth-queries";
import { revenueBySource } from "@/lib/analytics/growth-revenue";
import { backfillUserFirsts, type BackfillCounts } from "@/lib/analytics/growth-backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/growth/metrics — the read path for the growth pipeline.
 *
 * `lib/analytics/growth-queries.ts` shipped eleven ready-made SQL definitions
 * (retention, K-factor, DAU/WAU/MAU, the signup funnel, onboarding drop-off,
 * activation, acquisition, revenue by day, push performance) and NOTHING
 * imported a single one of them. So the numbers existed as strings in the repo
 * and nowhere else. This route runs every one of them and returns the rows.
 *
 * ── Why a route and not a dashboard page ────────────────────────────────────
 *
 * `web/app/admin/**` is untracked by policy so the ops dashboard never deploys.
 * Putting the READ here — under `app/api/admin`, which is tracked and gated by
 * `requireAdminApi` — means the local dashboard can fetch it, and so can a
 * one-line `curl`, without any of it being reachable without the admin token.
 * `requireAdminApi` accepts `x-admin-token`, the `talise_admin` cookie, or an
 * allowlisted signed-in identity, and on a Vercel deployment the dev-open
 * escape hatch is hard-disabled (see lib/admin-auth.ts).
 *
 * ── Pool discipline ─────────────────────────────────────────────────────────
 *
 * Production Postgres is `max: 8` and shared with the money paths, so this route
 * runs its twelve queries through a concurrency limiter of THREE and never holds
 * more than three connections. Each query is additionally raced against a
 * per-query budget: this schema has no `statement_timeout` anywhere, so without
 * a client-side cap one wedged connection would hang the whole response. A query
 * that misses its budget returns `[]` and is named in `partial`, so a dashboard
 * shows "not available" rather than a confident zero.
 *
 * Every query aggregates INSIDE Postgres and returns a handful of rows;
 * retention and DAU read the `growth_daily_active` rollup, never the raw event
 * log. Nothing here is on a hot path — the route is admin-only and force-dynamic.
 *
 *   GET  ?days=30              → every metric over the window
 *   POST { action:"backfill" } → derive the milestone columns + FX-spread fees
 */

/** Per-query ceiling. Covers pool queue wait plus execution, not expected latency. */
const QUERY_BUDGET_MS = 20_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

type Rows = Array<Record<string, unknown>>;

/** Names of queries that missed their budget or failed, so the caller can tell. */
type Partial_ = string[];

/**
 * Run labelled thunks three at a time, preserving order. A thunk that throws or
 * overruns yields `[]` and its label is collected — an analytics read must
 * degrade, never 500.
 */
async function runLimited(
  thunks: Array<[string, () => Promise<Rows>]>,
  partial: Partial_,
  limit = 3
): Promise<Rows[]> {
  const out = new Array<Rows>(thunks.length);
  let next = 0;
  async function worker() {
    while (next < thunks.length) {
      const i = next++;
      const [label, thunk] = thunks[i];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        out[i] = await Promise.race([
          thunk(),
          new Promise<Rows>((resolve) => {
            timer = setTimeout(() => {
              partial.push(`${label}:timeout`);
              resolve([]);
            }, QUERY_BUDGET_MS);
          }),
        ]);
      } catch (e) {
        console.warn(`[admin/growth/metrics] ${label} failed: ${(e as Error)?.message ?? e}`);
        partial.push(label);
        out[i] = [];
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker));
  return out;
}

export type GrowthMetricsResponse = {
  generatedAt: number;
  windowDays: number;
  from: number;
  to: number;
  /** Queries that timed out or errored. Empty means every number below is real. */
  partial: Partial_;
  dauWauMau: Rows;
  dauByPlatform: Rows;
  retentionD1: Rows;
  retentionD7: Rows;
  retentionD30: Rows;
  kFactor: Rows;
  signupFunnel: Rows;
  onboardingDropoff: Rows;
  activation: Rows;
  acquisition: Rows;
  revenueByDay: Rows;
  revenueBySource: Array<Record<string, unknown>>;
  pushPerformance: Rows;
};

export async function GET(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const rawDays = Number(url.searchParams.get("days"));
  const days = Number.isFinite(rawDays)
    ? Math.max(1, Math.min(MAX_DAYS, Math.floor(rawDays)))
    : DEFAULT_DAYS;

  const now = Date.now();
  const from = now - days * DAY_MS;
  const to = now;

  const partial: Partial_ = [];
  const [
    dwm,
    dauPlat,
    d1,
    d7,
    d30,
    k,
    funnel,
    dropoff,
    act,
    acq,
    revDay,
    push,
    revSource,
  ] = await runLimited(
    [
      ["dauWauMau", () => dauWauMau()],
      ["dauByPlatform", () => dauByPlatform(days)],
      // Retention cohorts are anchored on `users.created_at`, which predates
      // this pipeline, so the window is the SIGNUP window rather than the
      // activity window. A D30 cohort needs 30 days of hindsight, so the query
      // itself excludes cohorts too young to have a day N.
      ["retentionD1", () => dnRetention(from, to, 1)],
      ["retentionD7", () => dnRetention(from, to, 7)],
      ["retentionD30", () => dnRetention(from, to, 30)],
      ["kFactor", () => kFactor(from, to)],
      ["signupFunnel", () => signupFunnel(from, to)],
      ["onboardingDropoff", () => onboardingDropoff(from, to)],
      ["activation", () => activation(from, to)],
      ["acquisition", () => acquisition(from, to)],
      ["revenueByDay", () => revenueByDay(from, to)],
      ["pushPerformance", () => pushPerformance(from, to)],
      [
        "revenueBySource",
        () => revenueBySource(from) as unknown as Promise<Rows>,
      ],
    ],
    partial
  );

  const body: GrowthMetricsResponse = {
    generatedAt: now,
    windowDays: days,
    from,
    to,
    partial,
    dauWauMau: dwm,
    dauByPlatform: dauPlat,
    retentionD1: d1,
    retentionD7: d7,
    retentionD30: d30,
    kFactor: k,
    signupFunnel: funnel,
    onboardingDropoff: dropoff,
    activation: act,
    acquisition: acq,
    revenueByDay: revDay,
    revenueBySource: revSource,
    pushPerformance: push,
  };
  return NextResponse.json(body);
}

/**
 * POST /api/admin/growth/metrics  { action: "backfill", transferFeeLimit?: number }
 *
 * Derives the `growth_user_firsts` milestone columns for accounts that already
 * exist, and walks a bounded batch of settled `transfers` into `revenue_events`
 * as schedule-derived FX-spread rows. Idempotent and set-once, so it is safe to
 * run repeatedly; loop until `transferFees` comes back 0 to finish the fee walk.
 *
 * Deliberately NOT on a cron and NOT triggered by any user action: it is a
 * bounded admin operation against the shared pool.
 */
export async function POST(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;

  let body: { action?: unknown; transferFeeLimit?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* an empty body means the default action */
  }
  const action = typeof body.action === "string" ? body.action : "backfill";
  if (action !== "backfill") {
    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  }

  const rawLimit = Number(body.transferFeeLimit);
  const transferFeeLimit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(1_000, Math.floor(rawLimit)))
    : 200;

  let counts: BackfillCounts;
  try {
    counts = await backfillUserFirsts({ transferFeeLimit });
  } catch (e) {
    return NextResponse.json(
      { error: `backfill failed: ${(e as Error)?.message ?? e}` },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, ...counts });
}
