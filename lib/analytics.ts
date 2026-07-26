import { db } from "@/lib/db";
import { LIFETIME_TOTALS_SELECT } from "@/lib/analytics/ledger";

/**
 * Public, aggregate-only analytics for talise.io/analytics.
 *
 * Every number here is read live from production Postgres and is intentionally
 * NON-personal: counts, sums, and currency-pair tallies only. No address,
 * handle, email, digest, or counterparty ever leaves this function. The page
 * is meant to be honest, small, real, on-mainnet numbers beat inflated ones,
 * so we report what actually settled rather than rounding up.
 *
 * ## Lifetime figures come from the ledger, never from the feed
 *
 * `settled` and `byDirection` are derived from `analytics_tx_ledger` (durable,
 * one row per transaction digest for the lifetime of the product) via its
 * materialized single-row rollup. They used to be COUNT(*) / SUM over
 * `analytics_recent_tx`, which the indexer trims to the newest N rows on every
 * pass — so once lifetime activity passed that bound the published volume
 * stopped growing and then drifted DOWN as newer, smaller transactions
 * displaced older, larger ones. See lib/analytics/ledger.ts.
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

/** The product counts every version of this query returns. */
const PRODUCT_COUNTS = `
         (SELECT COUNT(*) FROM shield_commitments) AS notes,
         (SELECT COUNT(*) FROM shield_nullifiers)  AS spent,
         (SELECT COUNT(*) FROM cheques)            AS cheques,
         (SELECT COUNT(*) FROM streams)            AS streams,
         (SELECT COUNT(*) FROM savings_goals)      AS goals,
         (SELECT COUNT(*) FROM users)              AS accounts,
         (SELECT COUNT(*) FROM waitlist_signups)   AS waitlist`;

/**
 * The product counts AND the three lifetime figures in ONE round trip.
 *
 * The lifetime figures ride along as a cross-joined single-row projection of
 * the rollup, so correctness cost zero extra queries. If the ledger tables do
 * not exist yet (a cold database that has never run an indexer batch) the whole
 * statement fails to parse, which would zero the product counts too — so the
 * caller retries once with the counts alone rather than publishing seven
 * spurious zeros.
 */
const COUNTS_WITH_LIFETIME = `SELECT ${PRODUCT_COUNTS},
         lt.lifetime_tx_count,
         lt.lifetime_active_accounts,
         lt.lifetime_volume_usd
       FROM (${LIFETIME_TOTALS_SELECT}) AS lt`;

const COUNTS_ONLY = `SELECT ${PRODUCT_COUNTS}`;

export async function getPublicAnalytics(): Promise<PublicAnalytics> {
  // THREE independent round-trips, not twelve. Firing a dozen concurrent
  // COUNT(*)s starves the small Postgres pool, the tail queries queue past
  // the timeout and silently fall back to 0. Collapsing every simple count
  // into ONE multi-subquery SELECT keeps us comfortably under the pool size.
  const [counts, byDirectionRows, corridorRows] = await Promise.all([
    (async () => {
      const combined = await row1(COUNTS_WITH_LIFETIME);
      // row1 yields {} on failure/timeout. Degrade to counts-only so the
      // product figures survive a database that predates the ledger.
      if (Object.keys(combined).length > 0) return combined;
      return row1(COUNTS_ONLY);
    })(),
    withTimeout(
      (async () => {
        // Lifetime split by direction, over the durable ledger. Grouping the
        // trimmed feed here reported a rolling window as if it were all time.
        const r = await db().execute({
          sql: `SELECT direction, COUNT(*) n, COALESCE(SUM(amount_usd),0) vol
                FROM analytics_tx_ledger GROUP BY direction ORDER BY vol DESC`,
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
    settled: {
      volumeUsd: toNum(counts.lifetime_volume_usd),
      txCount: toNum(counts.lifetime_tx_count),
      activeAccounts: toNum(counts.lifetime_active_accounts),
    },
    byDirection: byDirectionRows,
    corridors: corridorRows,
    privacy: { notes: toNum(counts.notes), spent: toNum(counts.spent) },
    product: { cheques: toNum(counts.cheques), streams: toNum(counts.streams), goals: toNum(counts.goals) },
    community: { accounts: toNum(counts.accounts), waitlist: toNum(counts.waitlist) },
    updatedAt: new Date().toISOString(),
  };
}
