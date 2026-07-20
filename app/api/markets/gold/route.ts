import { NextResponse } from "next/server";
import { memoTtl } from "@/lib/perf-cache";

export const runtime = "nodejs";

/**
 * GET /api/markets/gold
 *
 * Live gold spot price for the Talise "Grow your wealth" surface. Gold is
 * Talise's first wealth product, for a naira/cedi/shilling user it's the
 * canonical inflation hedge, so we price it in USD here and the client maps
 * it through the user's display-currency FX (TaliseFormat.local2).
 *
 * Source: CoinGecko PAX-Gold (`pax-gold`), 1 PAXG == 1 fine troy oz of
 * LBMA-good-delivery gold, so its USD price tracks spot within a tenth of a
 * percent, and it's free + keyless with a 7-day market chart for the
 * sparkline. gold-api.com XAU is the spot fallback if CoinGecko is down.
 * Cached 90s server-side so the home card is instant and we stay well under
 * the free rate limit.
 *
 * Shape: { usdPerOz, usdPerGram, change24hPct, spark: number[], asOf }
 */

const GRAMS_PER_TROY_OZ = 31.1034768;
const COINGECKO = "https://api.coingecko.com/api/v3";
const GOLD_API = "https://api.gold-api.com/price/XAU";

export type GoldMarket = {
  usdPerOz: number;
  usdPerGram: number;
  change24hPct: number;
  /** ~daily closes over the last 7d, oldest→newest, for the card sparkline. */
  spark: number[];
  asOf: number;
};

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function fetchGold(): Promise<GoldMarket> {
  // Primary: CoinGecko PAX-Gold (price + 24h change + 7d sparkline).
  try {
    const [spotRaw, chartRaw] = await Promise.all([
      getJson(
        `${COINGECKO}/simple/price?ids=pax-gold&vs_currencies=usd&include_24hr_change=true`,
        5000,
      ),
      getJson(
        `${COINGECKO}/coins/pax-gold/market_chart?vs_currency=usd&days=7&interval=daily`,
        5000,
      ).catch(() => null),
    ]);
    const spot = (spotRaw as { "pax-gold"?: { usd?: number; usd_24h_change?: number } })[
      "pax-gold"
    ];
    const usdPerOz = Number(spot?.usd);
    if (!Number.isFinite(usdPerOz) || usdPerOz <= 0) throw new Error("bad coingecko price");
    const change24hPct = Number(spot?.usd_24h_change ?? 0);
    const prices = (chartRaw as { prices?: [number, number][] } | null)?.prices ?? [];
    const spark = prices
      .map((p) => Math.round(Number(p[1])))
      .filter((n) => Number.isFinite(n) && n > 0);
    return {
      usdPerOz,
      usdPerGram: usdPerOz / GRAMS_PER_TROY_OZ,
      change24hPct,
      spark: spark.length ? spark : [usdPerOz],
      asOf: Date.now(),
    };
  } catch {
    // Fallback: gold-api.com pure spot (no 24h / sparkline → derive flat).
    const g = (await getJson(GOLD_API, 5000)) as { price?: number };
    const usdPerOz = Number(g?.price);
    if (!Number.isFinite(usdPerOz) || usdPerOz <= 0) throw new Error("no gold price source");
    return {
      usdPerOz,
      usdPerGram: usdPerOz / GRAMS_PER_TROY_OZ,
      change24hPct: 0,
      spark: [usdPerOz],
      asOf: Date.now(),
    };
  }
}

export async function GET() {
  try {
    const data = await memoTtl("markets:gold", 90_000, fetchGold);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: "gold price unavailable", detail: (e as Error).message },
      { status: 503 },
    );
  }
}
