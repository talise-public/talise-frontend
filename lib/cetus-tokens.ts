import "server-only";

import { memoTtl } from "@/lib/perf-cache";

/**
 * Cetus token universe: the set of coins that have a real, liquid pool on
 * Cetus. This is the "verified / tradeable" allowlist (so blue-chips like WAL,
 * DEEP, CETUS show and are swappable, while no-liquidity spam never appears),
 * plus a best-effort symbol from the pool metadata.
 *
 * Source: Cetus's public `stats_pools` endpoint, ordered by 24h volume, so the
 * top pools (the ones that matter) come first. Cached for an hour; degrades to
 * an empty set on failure (the hardcoded floor in coins-verified.ts still
 * covers USDsui/SUI/USDC/DEEP/CETUS, so the wallet never breaks).
 */

const CETUS_STATS_POOLS =
  "https://api-sui.cetus.zone/v2/sui/stats_pools?is_vaults=false&display_all_pools=false&has_mining=false&no_fake_pool=true&order_by=-vol&limit=500";

/** Minimum pool TVL (USD) for a coin to count as tradeable, to keep thin spam out. */
const MIN_POOL_TVL_USD = 500;

/** Canonical coin type: lowercase + zero-pad the address to 64 hex. */
export function normCoinType(t: string): string {
  const parts = t.split("::");
  if (parts.length !== 3) return t.toLowerCase();
  const addr = parts[0].toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return `0x${addr}::${parts[1]}::${parts[2]}`;
}

type CetusPool = {
  coin_a_address?: string;
  coin_b_address?: string;
  coin_a?: string;
  coin_b?: string;
  pure_tvl_in_usd?: string | number;
};

export type CetusUniverse = {
  /** Normalized coin types that have a liquid Cetus pool. */
  verified: Set<string>;
  /** Normalized coin type -> ticker symbol (from pool metadata). */
  symbol: Map<string, string>;
};

/** Fetch + cache the Cetus token universe (1h). */
export function cetusUniverse(): Promise<CetusUniverse> {
  return memoTtl("cetus:universe", 60 * 60 * 1000, async () => {
    const empty: CetusUniverse = { verified: new Set(), symbol: new Map() };
    try {
      const res = await fetch(CETUS_STATS_POOLS, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return empty;
      const json = (await res.json()) as { data?: { lp_list?: CetusPool[] } };
      const pools = json.data?.lp_list ?? [];
      const verified = new Set<string>();
      const symbol = new Map<string, string>();
      for (const p of pools) {
        const tvl = Number(p.pure_tvl_in_usd ?? 0);
        if (Number.isFinite(tvl) && tvl < MIN_POOL_TVL_USD) continue;
        if (p.coin_a_address) {
          const n = normCoinType(p.coin_a_address);
          verified.add(n);
          if (p.coin_a && !symbol.has(n)) symbol.set(n, p.coin_a);
        }
        if (p.coin_b_address) {
          const n = normCoinType(p.coin_b_address);
          verified.add(n);
          if (p.coin_b && !symbol.has(n)) symbol.set(n, p.coin_b);
        }
      }
      return { verified, symbol };
    } catch {
      return empty;
    }
  });
}
