import { db } from "@/lib/db";

/**
 * Public, aggregate-only analytics for talise.io/analytics.
 *
 * Every number here is read live from production Postgres and is intentionally
 * NON-personal: counts, sums, and currency-pair tallies only. No address,
 * handle, email, digest, or counterparty ever leaves this function. The page
 * is meant to be honest, small, real, on-mainnet numbers beat inflated ones,
 * so we report what actually settled rather than rounding up.
 *
 * Resilient by construction: each sub-query is time-bounded and falls back to
 * 0 / [] so a single slow/failed aggregate can never 500 the page.
 */

const SUBQUERY_TIMEOUT_MS = 12_000;

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

export type DirectionStat = { direction: string; count: number; volumeUsd: number };
export type Corridor = { from: string; to: string; count: number };

export type PublicAnalytics = {
  settled: { volumeUsd: number; txCount: number; activeAccounts: number };
  byDirection: DirectionStat[];
  corridors: Corridor[];
  privacy: { notes: number; spent: number };
  product: { cheques: number; streams: number; goals: number };
  community: { accounts: number; waitlist: number };
  updatedAt: string;
};

function row1(sql: string): Promise<Record<string, unknown>> {
  return withTimeout(
    (async () => {
      const r = await db().execute({ sql });
      return (r.rows[0] ?? {}) as Record<string, unknown>;
    })(),
    {} as Record<string, unknown>
  );
}
const toNum = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function getPublicAnalytics(): Promise<PublicAnalytics> {
  // Four independent round-trips, not twelve. Firing a dozen concurrent
  // COUNT(*)s starves the small Postgres pool, the tail queries queue past
  // the timeout and silently fall back to 0. Collapsing every simple count
  // into ONE multi-subquery SELECT keeps us comfortably under the pool size.
  const [counts, tx, byDirectionRows, corridorRows] = await Promise.all([
    // All the plain counts in a single query.
    row1(
      `SELECT
         (SELECT COUNT(*) FROM shield_commitments) AS notes,
         (SELECT COUNT(*) FROM shield_nullifiers)  AS spent,
         (SELECT COUNT(*) FROM cheques)            AS cheques,
         (SELECT COUNT(*) FROM streams)            AS streams,
         (SELECT COUNT(*) FROM savings_goals)      AS goals,
         (SELECT COUNT(*) FROM users)              AS accounts,
         (SELECT COUNT(*) FROM waitlist_signups)   AS waitlist`
    ),
    // Transaction totals. "Value moved" counts user-initiated flows only
    // (sent, swap, withdraw, invest); `received` is excluded as the mirror
    // side of `sent` to avoid double-counting the same dollars.
    row1(
      `SELECT
         COUNT(*)                                  AS txcount,
         COUNT(DISTINCT address)                   AS active,
         COALESCE(SUM(amount_usd) FILTER (
           WHERE direction IN ('sent','swap','withdraw','invest')),0) AS vol
       FROM analytics_recent_tx`
    ),
    withTimeout(
      (async () => {
        const r = await db().execute({
          sql: `SELECT direction, COUNT(*) n, COALESCE(SUM(amount_usd),0) vol
                FROM analytics_recent_tx GROUP BY direction ORDER BY vol DESC`,
        });
        return r.rows.map((rw) => {
          const v = Object.values(rw);
          return { direction: String(v[0] ?? "-"), count: toNum(v[1]), volumeUsd: toNum(v[2]) };
        });
      })(),
      [] as DirectionStat[]
    ),
    withTimeout(
      (async () => {
        const r = await db().execute({
          sql: `SELECT source_currency, dest_currency, COUNT(*) n
                FROM transfers GROUP BY source_currency, dest_currency
                ORDER BY n DESC`,
        });
        return r.rows
          .map((rw) => {
            const v = Object.values(rw);
            return { from: String(v[0] ?? ""), to: String(v[1] ?? ""), count: toNum(v[2]) };
          })
          .filter((c) => c.from && c.to);
      })(),
      [] as Corridor[]
    ),
  ]);

  return {
    settled: { volumeUsd: toNum(tx.vol), txCount: toNum(tx.txcount), activeAccounts: toNum(tx.active) },
    byDirection: byDirectionRows,
    corridors: corridorRows,
    privacy: { notes: toNum(counts.notes), spent: toNum(counts.spent) },
    product: { cheques: toNum(counts.cheques), streams: toNum(counts.streams), goals: toNum(counts.goals) },
    community: { accounts: toNum(counts.accounts), waitlist: toNum(counts.waitlist) },
    updatedAt: new Date().toISOString(),
  };
}
