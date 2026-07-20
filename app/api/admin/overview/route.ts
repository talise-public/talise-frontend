import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { requireAdminApi } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/overview, top-level KPIs across the whole database.
 * One round of aggregate queries; resilient (a failed sub-query yields
 * 0 / [] rather than 500-ing the page).
 */

// This page fans out ~26 aggregates via Promise.all over a small pool. The
// route is meant to be resilient, a failed sub-query yields 0/[] rather than
// 500-ing. But a HUNG query (e.g. a stale pooled connection that never
// settles) isn't a failure: it would make Promise.all wait forever and wedge
// the whole dashboard on "Loading…". So we bound every sub-query in time and
// treat a timeout exactly like an error → 0/[]. The dashboard always renders;
// at worst one stat shows 0 until the next refresh.
// Generous: this page fans 26 queries over a max:8 pool, so the heaviest
// COUNT(*)s wait several seconds for a connection BEFORE running. The budget
// is measured from dispatch, so it must cover (queue wait + query time). Its
// only job is to stop an infinite hang, not to be the expected latency.
const SUBQUERY_TIMEOUT_MS = 20_000;

async function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), SUBQUERY_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function scalar(sql: string, args: ReadonlyArray<unknown> = []): Promise<number> {
  return withTimeout(
    (async () => {
      const r = await db().execute({ sql, args });
      const v = r.rows[0] ? Object.values(r.rows[0])[0] : 0;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    })(),
    0
  );
}

async function groupCounts(
  sql: string,
  args: ReadonlyArray<unknown> = []
): Promise<Array<{ key: string; count: number }>> {
  return withTimeout(
    (async () => {
      const r = await db().execute({ sql, args });
      return r.rows.map((row) => {
        const vals = Object.values(row);
        return { key: String(vals[0] ?? "-"), count: Number(vals[1] ?? 0) };
      });
    })(),
    []
  );
}

/**
 * Run async thunks with bounded concurrency, preserving result order. This
 * page issues ~26 COUNT(*)s; firing them all at once saturates the small
 * connection pool, so the heaviest counts wait behind others and trip the
 * per-query timeout. A limit of 6 (under the max:8 pool) keeps every query
 * moving and makes the page return in a few seconds with complete data.
 */
async function runLimited<T>(thunks: Array<() => Promise<T>>, limit = 6): Promise<T[]> {
  const results = new Array<T>(thunks.length);
  let next = 0;
  async function worker() {
    while (next < thunks.length) {
      const i = next++;
      results[i] = await thunks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker));
  return results;
}

export async function GET(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;

  await ensureSchema().catch(() => {});

  const now = Date.now();
  const day = now - 24 * 60 * 60 * 1000;
  const week = now - 7 * 24 * 60 * 60 * 1000;

  const [
    usersTotal,
    usersNew24h,
    usersNew7d,
    usersByTier,
    usersByType,
    waitlistTotal,
    waitlistConfirmed,
    waitlistClaimed,
    waitlistLegacy,
    txTotal,
    txNew24h,
    transfersTotal,
    transfersByState,
    transfersParked,
    linqTotal,
    linqByStatus,
    invoicesTotal,
    invoicesPaid,
    roundupPending,
    kycIntents,
    travelRecords,
    floatPools,
    floatUsdc,
    rewardsEvents,
    redemptions,
    savingsGoals,
  ] = await runLimited<number | Array<{ key: string; count: number }>>([
    () => scalar(`SELECT COUNT(*) FROM users`),
    () => scalar(`SELECT COUNT(*) FROM users WHERE created_at >= $1`, [day]),
    () => scalar(`SELECT COUNT(*) FROM users WHERE created_at >= $1`, [week]),
    () => groupCounts(`SELECT COALESCE(kyc_tier,0) AS t, COUNT(*) FROM users GROUP BY 1 ORDER BY 1`),
    () => groupCounts(`SELECT COALESCE(account_type,'personal') AS t, COUNT(*) FROM users GROUP BY 1 ORDER BY 2 DESC`),
    () => scalar(`SELECT COUNT(*) FROM waitlist_signups`),
    () => scalar(`SELECT COUNT(*) FROM waitlist_signups WHERE confirmation_sent = true`),
    () => scalar(`SELECT COUNT(*) FROM waitlist_signups WHERE claimed_handle IS NOT NULL`),
    () => scalar(`SELECT COUNT(*) FROM waitlist`),
    () => scalar(`SELECT COUNT(*) FROM tx_history`),
    () => scalar(`SELECT COUNT(*) FROM tx_history WHERE created_at >= $1`, [day]),
    () => scalar(`SELECT COUNT(*) FROM transfers`),
    () => groupCounts(`SELECT state, COUNT(*) FROM transfers GROUP BY state ORDER BY 2 DESC`),
    () => scalar(`SELECT COUNT(*) FROM transfers WHERE parked_funds = true`),
    () => scalar(`SELECT COUNT(*) FROM linq_offramps`),
    () => groupCounts(`SELECT status, COUNT(*) FROM linq_offramps GROUP BY status ORDER BY 2 DESC`),
    () => scalar(`SELECT COUNT(*) FROM invoices`),
    () => scalar(`SELECT COUNT(*) FROM invoices WHERE status = 'paid'`),
    () => scalar(`SELECT COUNT(*) FROM roundup_queue WHERE processed_at IS NULL`),
    () => scalar(`SELECT COUNT(*) FROM kyc_upgrade_intents`),
    () => scalar(`SELECT COUNT(*) FROM travel_rule_records`),
    () => scalar(`SELECT COUNT(*) FROM float_pools`),
    () => scalar(`SELECT COALESCE(SUM(usdc_pool),0) FROM float_pools`),
    () => scalar(`SELECT COUNT(*) FROM rewards_events`),
    () => scalar(`SELECT COUNT(*) FROM redemptions`),
    () => scalar(`SELECT COUNT(*) FROM savings_goals WHERE archived = 0`),
  ]) as [
    number, number, number,
    Array<{ key: string; count: number }>, Array<{ key: string; count: number }>,
    number, number, number, number, number, number, number,
    Array<{ key: string; count: number }>,
    number, number,
    Array<{ key: string; count: number }>,
    number, number, number, number, number, number, number, number, number, number,
  ];

  // Roll transfers + linq off-ramp states up into success / pending / failed.
  const SUCCESS = new Set(["settled", "onchain_settled"]);
  const FAILED = new Set(["failed", "refunded", "rejected"]);
  function rollup(rows: Array<{ key: string; count: number }>) {
    let success = 0,
      failed = 0,
      pending = 0;
    for (const { key, count } of rows) {
      const k = key.toLowerCase();
      if (SUCCESS.has(k) || /success|paid|complete|settled/.test(k)) success += count;
      else if (FAILED.has(k) || /fail|refund|reject|cancel|expire/.test(k)) failed += count;
      else pending += count;
    }
    return { success, pending, failed };
  }
  const transferRoll = rollup(transfersByState);
  const linqRoll = rollup(linqByStatus);

  // tx_history rows are recorded only after on-chain confirmation → all
  // count as successful.
  const txSuccess = txTotal + transferRoll.success + linqRoll.success;
  const txPending = transferRoll.pending + linqRoll.pending;
  const txFailed = transferRoll.failed + linqRoll.failed;

  return NextResponse.json({
    generatedAt: now,
    users: {
      total: usersTotal,
      new24h: usersNew24h,
      new7d: usersNew7d,
      byTier: usersByTier,
      byType: usersByType,
    },
    waitlist: {
      total: waitlistTotal,
      confirmed: waitlistConfirmed,
      claimedHandles: waitlistClaimed,
      legacy: waitlistLegacy,
    },
    transactions: {
      onchain: txTotal,
      onchain24h: txNew24h,
      transfers: transfersTotal,
      linq: linqTotal,
      success: txSuccess,
      pending: txPending,
      failed: txFailed,
      transfersByState,
      linqByStatus,
      parked: transfersParked,
    },
    commerce: {
      invoicesTotal,
      invoicesPaid,
      rewardsEvents,
      redemptions,
      savingsGoals,
    },
    compliance: {
      kycIntents,
      travelRecords,
      floatPools,
      floatUsdc,
      roundupPending,
    },
  });
}
