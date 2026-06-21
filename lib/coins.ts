import "server-only";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

/**
 * Summary of a single coin type the user owns. Aggregates every `Coin<T>`
 * object the user holds for that type into one balance, with metadata pulled
 * from `suix_getCoinMetadata`.
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

let _client: SuiJsonRpcClient | null = null;
function mainnetClient(): SuiJsonRpcClient {
  if (_client) return _client;
  _client = new SuiJsonRpcClient({
    url: getJsonRpcFullnodeUrl("mainnet"),
    network: "mainnet",
  });
  return _client;
}

type CachedMeta = { symbol: string; decimals: number };
// Coin metadata is immutable per type, so a process-lifetime cache is safe.
const METADATA_CACHE = new Map<string, CachedMeta>();

async function getMetadata(
  client: SuiJsonRpcClient,
  coinType: string
): Promise<CachedMeta> {
  const hit = METADATA_CACHE.get(coinType);
  if (hit) return hit;
  try {
    const md = await client.getCoinMetadata({ coinType });
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
  const client = mainnetClient();

  // Page through all owned Coin objects.
  const totals = new Map<string, bigint>();
  let cursor: string | null | undefined = null;
  // Defensive cap: 50 pages * default page size is well beyond any realistic
  // wallet but keeps us from spinning if the node returns a bad cursor.
  for (let page = 0; page < 50; page++) {
    const res = await client.getAllCoins({
      owner,
      cursor: cursor ?? null,
    });
    for (const c of res.data) {
      const prev = totals.get(c.coinType) ?? 0n;
      totals.set(c.coinType, prev + BigInt(c.balance));
    }
    if (!res.hasNextPage || !res.nextCursor) break;
    cursor = res.nextCursor;
  }

  // Drop zero-balance types and resolve metadata in parallel.
  const nonZero = [...totals.entries()].filter(([, bal]) => bal > 0n);
  const summaries = await Promise.all(
    nonZero.map<Promise<OwnedCoinSummary>>(async ([coinType, balance]) => {
      const { symbol, decimals } = await getMetadata(client, coinType);
      const divisor = 10 ** decimals;
      const amount = divisor > 0 ? Number(balance) / divisor : Number(balance);
      return { coinType, symbol, balance, decimals, amount };
    })
  );

  return summaries;
}
