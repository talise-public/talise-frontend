/**
 * Display metadata for every WaterX perp market (all 30). Names, ticker symbol
 * (for logos), category, a brand colour (badge fallback), and the Pyth feed
 * symbol used for the chart. Shared by the server (market list) and the client
 * (icons / picker).
 */
export type AssetCategory = "crypto" | "stock" | "fx" | "commodity";
export type AssetMeta = { name: string; sym: string; cat: AssetCategory; pyth: string; color: string };

const crypto = (name: string, sym: string, color: string): AssetMeta => ({ name, sym, cat: "crypto", pyth: `Crypto.${sym}/USD`, color });
const stock = (name: string, sym: string, color: string): AssetMeta => ({ name, sym, cat: "stock", pyth: `Equity.US.${sym}/USD`, color });

export const ASSET_META: Record<string, AssetMeta> = {
  BTCUSD: crypto("Bitcoin", "BTC", "#f7931a"),
  ETHUSD: crypto("Ethereum", "ETH", "#627eea"),
  SOLUSD: crypto("Solana", "SOL", "#14b789"),
  SUIUSD: crypto("Sui", "SUI", "#4da2ff"),
  BNBUSD: crypto("BNB", "BNB", "#e3a80c"),
  XRPUSD: crypto("XRP", "XRP", "#23292f"),
  DOGEUSD: crypto("Dogecoin", "DOGE", "#b59a2e"),
  HYPEUSD: crypto("Hyperliquid", "HYPE", "#12a594"),
  ZECUSD: crypto("Zcash", "ZEC", "#d9a021"),
  LITUSD: crypto("Litentry", "LIT", "#3d7a29"),
  DEEPUSD: crypto("DeepBook", "DEEP", "#2a67f5"),
  WALUSD: crypto("Walrus", "WAL", "#2f8f6b"),

  TSLAXUSD: stock("Tesla", "TSLA", "#e2231a"),
  NVDAXUSD: stock("Nvidia", "NVDA", "#76b900"),
  AAPLXUSD: stock("Apple", "AAPL", "#555555"),
  GOOGLXUSD: stock("Alphabet", "GOOGL", "#4285f4"),
  METAXUSD: stock("Meta", "META", "#0866ff"),
  MSTRXUSD: stock("MicroStrategy", "MSTR", "#e8912d"),
  COINXUSD: stock("Coinbase", "COIN", "#0052ff"),
  HOODXUSD: stock("Robinhood", "HOOD", "#0ac05a"),
  CRCLXUSD: stock("Circle", "CRCL", "#3ba55d"),
  NFLXXUSD: stock("Netflix", "NFLX", "#e50914"),
  QQQXUSD: stock("Nasdaq 100", "QQQ", "#6f42c1"),
  SPYXUSD: stock("S&P 500", "SPY", "#1f6feb"),

  EURUSD: { name: "Euro", sym: "EUR", cat: "fx", pyth: "FX.EUR/USD", color: "#1d4ed8" },
  USDJPY: { name: "US Dollar / Yen", sym: "JPY", cat: "fx", pyth: "FX.USD/JPY", color: "#bc002d" },

  XAUTUSD: { name: "Gold", sym: "XAU", cat: "commodity", pyth: "Metal.XAU/USD", color: "#d4af37" },
  XAGUSD: { name: "Silver", sym: "XAG", cat: "commodity", pyth: "Metal.XAG/USD", color: "#9ca3af" },
  WTIUSD: { name: "Crude Oil (WTI)", sym: "WTI", cat: "commodity", pyth: "Commodities.WTI/USD", color: "#3f3f46" },
  BRENTUSD: { name: "Brent Oil", sym: "BRENT", cat: "commodity", pyth: "Commodities.BRENT/USD", color: "#27272a" },
};

// Display order: majors first, then the rest grouped by category.
export const WATERX_TICKERS = Object.keys(ASSET_META);

export function assetMeta(ticker: string): AssetMeta {
  const t = ticker.toUpperCase();
  if (ASSET_META[t]) return ASSET_META[t];
  const sym = t.replace(/USD$/, "");
  return { name: sym, sym, cat: "crypto", pyth: `Crypto.${sym}/USD`, color: "#3d7a29" };
}

export function pythSymbolFor(ticker: string): string {
  return assetMeta(ticker).pyth;
}

export const CATEGORIES: { key: AssetCategory | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "crypto", label: "Crypto" },
  { key: "stock", label: "Stocks" },
  { key: "fx", label: "FX" },
  { key: "commodity", label: "Commodities" },
];
