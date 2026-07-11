import "server-only";
import { sui } from "./sui";

/**
 * Summary of a single coin type the user owns. Aggregates every `Coin<T>`
 * object the user holds for that type into one balance, with metadata pulled
 * from the coin's on-chain `CoinMetadata`.
 */
export type OwnedCoinSummary = {
  coinType: string;
  /** Best-effort symbol from coin metadata (e.g. "USDC", "SUI", "WAL"). */
  symbol: string;
  /** Raw smallest-unit balance (sum across all coin objects). */
  balance: bigint;
  /** Decimals from coin metadata. */
  decimals: number;
  /** Human-readable amount (balance / 10^decimals). */
  amount: number;
};

type CachedMeta = { symbol: string; decimals: number };
// Coin metadata is immutable per type, so a process-lifetime cache is safe.
const METADATA_CACHE = new Map<string, CachedMeta>();

async function getMetadata(coinType: string): Promise<CachedMeta> {
  const hit = METADATA_CACHE.get(coinType);
  if (hit) return hit;
  try {
    // gRPC `getCoinMetadata` wraps the metadata in a `.coinMetadata` field
    // (JSON-RPC returned it at the top level); it is `null` when the coin has
    // no published `CoinMetadata` object.
    const res = await sui().getCoinMetadata({ coinType });
    const md = res.coinMetadata;
    if (md) {
      const out: CachedMeta = {
        symbol: md.symbol || fallbackSymbol(coinType),
        decimals: typeof md.decimals === "number" ? md.decimals : 0,
      };
      METADATA_CACHE.set(coinType, out);
      return out;
    }
  } catch {
    // fall through to default
  }
  const fallback: CachedMeta = {
    symbol: fallbackSymbol(coinType),
    decimals: 0,
  };
  METADATA_CACHE.set(coinType, fallback);
  return fallback;
}

/** Pull a readable symbol from the type's last segment when no metadata exists. */
function fallbackSymbol(coinType: string): string {
  const last = coinType.split("::").pop() ?? coinType;
  return last.replace(/<.*$/, "");
}

/**
 * Fetch every coin type the user owns on Sui mainnet, summed across objects.
 * Filters out types with zero balance. Returns one entry per coin type.
 */
export async function getOwnedCoins(
  owner: string
): Promise<OwnedCoinSummary[]> {
  // gRPC `listBalances` returns one already-aggregated `{ coinType, balance }`
  // row per coin type the owner holds — the same summed-by-type shape the old
  // JSON-RPC `getAllCoins` loop produced by hand, so we no longer page through
  // individual coin objects. Paginate defensively in case a whale holds more
  // types than one page returns.
  const totals = new Map<string, bigint>();
  let cursor: string | null | undefined = null;
  // Defensive cap: 50 pages is well beyond any realistic wallet but keeps us
  // from spinning if the node returns a bad cursor.
  for (let page = 0; page < 50; page++) {
    const res = await sui().listBalances({
      owner,
      cursor: cursor ?? null,
    });
    for (const b of res.balances) {
      const prev = totals.get(b.coinType) ?? 0n;
      totals.set(b.coinType, prev + BigInt(b.balance));
    }
    if (!res.hasNextPage || !res.cursor) break;
    cursor = res.cursor;
  }

  // Drop zero-balance types and resolve metadata in parallel.
  const nonZero = [...totals.entries()].filter(([, bal]) => bal > 0n);
  const summaries = await Promise.all(
    nonZero.map<Promise<OwnedCoinSummary>>(async ([coinType, balance]) => {
      const { symbol, decimals } = await getMetadata(coinType);
      const divisor = 10 ** decimals;
      const amount = divisor > 0 ? Number(balance) / divisor : Number(balance);
      return { coinType, symbol, balance, decimals, amount };
    })
  );

  return summaries;
}
