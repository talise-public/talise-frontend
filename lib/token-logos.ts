/**
 * Curated logo URLs for major Sui tokens.
 *
 * On-chain `suix_getCoinMetadata` frequently returns NO iconUrl (WAL, DEEP, and
 * many others), which left the token bucket showing blank circles. Cetus's
 * `stats_pools` gives us symbols but not logos, so we keep a small curated map
 * sourced from Cetus / Noodles (the Walrus-backed datasprite CDN) and use it as
 * a fallback when metadata has no icon.
 *
 * Keyed by UPPERCASE ticker symbol, the symbol is already resolved (from
 * on-chain metadata or the Cetus pool universe) before this lookup, so it works
 * regardless of the coin's package id.
 */
const LOGO_BY_SYMBOL: Record<string, string> = {
  WAL: "https://yfjzsmchoivhp3zhqlacfnt3i77kdvuegwm3e5hau57gysczheba.mainnet-1.datasprite-cdn.com/E1fczQ2h9Pn12QeaDcVHuaRvgWMRymR5gzczKcHcsvX3/",
  SUI: "https://archive.cetus.zone/assets/image/sui/sui.png",
  DEEP: "https://icb2ijkzbrb2q2i642eqqke6nsgukabtms5bek276sjcutzvo6nq.mainnet-1.datasprite-cdn.com/5LqWyWG5EU9wPknvW5rY6qSQPtnNAfP27X1PnAiesyFG/",
  USDC: "https://yu2xpvqkbz64raedp4gnqbjpedosbatzske74b7c6cieyzx66yua.mainnet-1.datasprite-cdn.com/EGpc2cG886CrWwLMneF2RyVpZ7D33a6znz6XE8n8nU7h/",
};

/** Curated logo for a ticker symbol, or null when we don't have one. */
export function logoForSymbol(symbol: string | null | undefined): string | null {
  if (!symbol) return null;
  return LOGO_BY_SYMBOL[symbol.trim().toUpperCase()] ?? null;
}
