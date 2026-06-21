/**
 * Thin wrapper over @mysten/deepbook-v3 for the reads Talise needs:
 *
 *  - Live mid-price of any DeepBook spot pool (e.g. SUI/USDC).
 *  - Margin lending pool stats (supply, borrow, interest rate, utilization).
 *
 * All queries use the SDK's simulateTransaction path under the hood, so they
 * don't broadcast anything — just observe on-chain state.
 *
 * The DeepBookClient needs a `sender` address even for read-only sims. We use
 * a constant placeholder address; replace via `forUser(...)` if you want
 * user-scoped reads (relevant for borrow position queries later).
 */

import { DeepBookClient } from "@mysten/deepbook-v3";
import { sui, network } from "./sui";

// Any valid Sui address works as the sim sender — we never broadcast.
const SIM_SENDER =
  "0x0000000000000000000000000000000000000000000000000000000000000001";

let _client: DeepBookClient | null = null;

export function deepbook(): DeepBookClient {
  if (_client) return _client;
  _client = new DeepBookClient({
    // SuiClient satisfies the DeepBookCompatibleClient interface via its core API.
    client: sui() as never,
    address: SIM_SENDER,
    network: network() === "mainnet" ? "mainnet" : "testnet",
  });
  return _client;
}

/**
 * Live USDC-per-SUI mid-price via a 1-SUI quote simulation. Returns 0 on error.
 * Pool: SUI_USDC on mainnet = 0xe05dafb5…
 */
/**
 * Returns the price of the pool's base coin in quote units.
 * (For SUI_USDC: USDC per 1 SUI. For DEEP_SUI: SUI per 1 DEEP.)
 */
export async function getPoolPrice(poolKey: string): Promise<number> {
  try {
    const db = deepbook();
    const out = await db.getQuoteQuantityOut(poolKey, 1);
    const price = Number(out.quoteOut);
    return Number.isFinite(price) && price > 0 ? price : 0;
  } catch (err) {
    console.warn(`[deepbook] ${poolKey} price fetch failed:`, (err as Error).message);
    return 0;
  }
}

export async function getSuiUsdcPrice(): Promise<number> {
  return getPoolPrice("SUI_USDC");
}

export type MarketRow = {
  pair: string;
  base: string;
  quote: string;
  price: number;
};

const FEATURED_POOLS: { pair: string; base: string; quote: string; poolKey: string }[] = [
  { pair: "SUI / USDC", base: "SUI", quote: "USDC", poolKey: "SUI_USDC" },
  { pair: "DEEP / USDC", base: "DEEP", quote: "USDC", poolKey: "DEEP_USDC" },
  { pair: "DEEP / SUI", base: "DEEP", quote: "SUI", poolKey: "DEEP_SUI" },
  { pair: "WAL / USDC", base: "WAL", quote: "USDC", poolKey: "WAL_USDC" },
  { pair: "NS / USDC", base: "NS", quote: "USDC", poolKey: "NS_USDC" },
  { pair: "XBTC / USDC", base: "XBTC", quote: "USDC", poolKey: "XBTC_USDC" },
];

/**
 * Fetch live prices for the curated set of mainnet DeepBook pools.
 * Returns one row per pool; price=0 means the pool was unreachable.
 */
export async function getFeaturedMarkets(): Promise<MarketRow[]> {
  const settled = await Promise.allSettled(
    FEATURED_POOLS.map((p) => getPoolPrice(p.poolKey))
  );
  return FEATURED_POOLS.map((p, i) => ({
    pair: p.pair,
    base: p.base,
    quote: p.quote,
    price: settled[i].status === "fulfilled" ? (settled[i] as PromiseFulfilledResult<number>).value : 0,
  }));
}

export type MarginPoolInfo = {
  coin: string;
  totalSupply: number;
  totalBorrow: number;
  utilization: number;
  /** Supply APR as a decimal (0.064 = 6.4%) — borrow rate * utilization (rough). */
  supplyApr: number;
  /** Borrow APR as a decimal (0.082 = 8.2%). */
  borrowApr: number;
};

/**
 * Fetch margin-pool stats for a coin key ("USDC", "SUI", "DEEP", "WAL", "XBTC").
 * Returns null if the pool isn't available or the query fails.
 */
export async function getMarginPoolInfo(
  coin: "USDC" | "SUI" | "DEEP" | "WAL" | "XBTC"
): Promise<MarginPoolInfo | null> {
  if (network() !== "mainnet") return null;
  try {
    const db = deepbook();
    const [supplyStr, borrowStr, borrowRate] = await Promise.all([
      db.getMarginPoolTotalSupply(coin),
      db.getMarginPoolTotalBorrow(coin),
      db.getMarginPoolInterestRate(coin),
    ]);
    const totalSupply = parseFloat(supplyStr);
    const totalBorrow = parseFloat(borrowStr);
    const utilization = totalSupply > 0 ? totalBorrow / totalSupply : 0;
    // borrowRate from SDK is already a fraction (e.g. 0.082 = 8.2%)
    const borrowApr = Number(borrowRate);
    // Supply APR ≈ borrow rate × utilization (ignoring protocol spread for v1).
    const supplyApr = borrowApr * utilization;
    return {
      coin,
      totalSupply,
      totalBorrow,
      utilization,
      supplyApr,
      borrowApr,
    };
  } catch (err) {
    console.warn(
      `[deepbook] margin pool ${coin} fetch failed:`,
      (err as Error).message
    );
    return null;
  }
}
