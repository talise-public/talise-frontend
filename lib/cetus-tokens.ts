import "server-only";

import { memoTtl } from "@/lib/perf-cache";

/**
 * Cetus token universe: the set of coins that have a real, liquid pool on
 * Cetus (the "verified / tradeable" allowlist), plus, from the SAME cached
 * fetch, each coin's ticker symbol, its logo URL, and a derived USD price.
 *
 * Source: Cetus's public `stats_pools` endpoint, ordered by 24h volume. Cached
 * for an hour; degrades to empty on failure (the hardcoded floor in
 * coins-verified.ts still covers the majors, so the wallet never breaks).
 *
 * PRICES: the per-pool `price` field is an unreliable raw ratio (a USDC/USDsui
 * pool reports ~66, not ~1), so we DON'T use it. Instead we anchor the $1
 * stablecoins (USDC, USDsui) and solve each pool for the unknown side using the
 * Cetus-computed `pure_tvl_in_usd` and the reserve balances:
 *     TVL = bal_a·price_a + bal_b·price_b   ⇒   price_other = (TVL − bal_known·price_known) / bal_other
 * Propagating over a few passes lights up SUI (from USDC-SUI), then WAL/DEEP/…
 * (from their SUI pools). Deepest pool wins, so the price is the liquid one.
 */

const CETUS_STATS_POOLS =
  "https://api-sui.cetus.zone/v2/sui/stats_pools?is_vaults=false&display_all_pools=false&has_mining=false&no_fake_pool=true&order_by=-vol&limit=500";

/** Minimum pool TVL (USD) for a coin to count as tradeable, to keep thin spam out. */
const MIN_POOL_TVL_USD = 500;
/** Higher floor for price derivation, thin pools give noisy implied prices. */
const MIN_PRICE_TVL_USD = 2000;
/** Symbols pinned to $1 as the price-propagation anchors. */
const STABLE_ANCHORS = new Set(["USDC", "USDSUI"]);

/** Canonical coin type: lowercase + zero-pad the address to 64 hex. */
export function normCoinType(t: string): string {
  const parts = t.split("::");
  if (parts.length !== 3) return t.toLowerCase();
  const addr = parts[0].toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return `0x${addr}::${parts[1]}::${parts[2]}`;
}

type CetusCoin = {
  symbol?: string;
  decimals?: number;
  address?: string;
  balance?: string;
  logo_url?: string;
};
type CetusPool = {
  coin_a_address?: string;
  coin_b_address?: string;
  coin_a?: CetusCoin;
  coin_b?: CetusCoin;
  pure_tvl_in_usd?: string | number;
};

export type CetusUniverse = {
  /** Normalized coin types that have a liquid Cetus pool. */
  verified: Set<string>;
  /** Normalized coin type -> ticker symbol. */
  symbol: Map<string, string>;
  /** Normalized coin type -> logo URL (from Cetus pool metadata). */
  logo: Map<string, string>;
  /** Normalized coin type -> derived USD price. */
  priceUsd: Map<string, number>;
};

/** Fetch + cache the Cetus token universe (1h). */
export function cetusUniverse(): Promise<CetusUniverse> {
  return memoTtl("cetus:universe", 60 * 60 * 1000, async () => {
    const empty: CetusUniverse = {
      verified: new Set(),
      symbol: new Map(),
      logo: new Map(),
      priceUsd: new Map(),
    };
    try {
      const res = await fetch(CETUS_STATS_POOLS, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return empty;
      const json = (await res.json()) as { data?: { lp_list?: CetusPool[] } };
      const pools = json.data?.lp_list ?? [];

      const verified = new Set<string>();
      const symbol = new Map<string, string>();
      const logo = new Map<string, string>();
      const priceUsd = new Map<string, number>();

      // Pass 1: verified set, symbols, logos, and seed the $1 anchors.
      for (const p of pools) {
        const tvl = Number(p.pure_tvl_in_usd ?? 0);
        const sides: Array<[string | undefined, CetusCoin | undefined]> = [
          [p.coin_a_address, p.coin_a],
          [p.coin_b_address, p.coin_b],
        ];
        for (const [addr, coin] of sides) {
          if (!addr) continue;
          const n = normCoinType(addr);
          if (Number.isFinite(tvl) && tvl >= MIN_POOL_TVL_USD) verified.add(n);
          const sym = coin?.symbol;
          if (sym && !symbol.has(n)) symbol.set(n, sym);
          if (coin?.logo_url && !logo.has(n)) logo.set(n, coin.logo_url);
          if (sym && STABLE_ANCHORS.has(sym.toUpperCase())) priceUsd.set(n, 1);
        }
      }

      // Passes 2-5: solve each pool for its unknown side via TVL + reserves.
      // Deepest pool wins (bestTvl), so a coin's price comes from its most
      // liquid market.
      const bestTvl = new Map<string, number>();
      for (let pass = 0; pass < 4; pass++) {
        for (const p of pools) {
          const tvl = Number(p.pure_tvl_in_usd ?? 0);
          if (!Number.isFinite(tvl) || tvl < MIN_PRICE_TVL_USD) continue;
          if (!p.coin_a_address || !p.coin_b_address) continue;
          const na = normCoinType(p.coin_a_address);
          const nb = normCoinType(p.coin_b_address);
          const balA = Number(p.coin_a?.balance ?? 0);
          const balB = Number(p.coin_b?.balance ?? 0);
          if (!(balA > 0) || !(balB > 0)) continue;
          const pa = priceUsd.get(na);
          const pb = priceUsd.get(nb);
          if (pa != null && pb == null) {
            const v = (tvl - balA * pa) / balB;
            if (v > 0 && tvl > (bestTvl.get(nb) ?? 0)) {
              priceUsd.set(nb, v);
              bestTvl.set(nb, tvl);
            }
          } else if (pb != null && pa == null) {
            const v = (tvl - balB * pb) / balA;
            if (v > 0 && tvl > (bestTvl.get(na) ?? 0)) {
              priceUsd.set(na, v);
              bestTvl.set(na, tvl);
            }
          }
        }
      }

      return { verified, symbol, logo, priceUsd };
    } catch {
      return empty;
    }
  });
}
