import { NextResponse } from "next/server";
import { WATERX_ENABLED } from "@/lib/waterx";
import { WATERX_TICKERS } from "@/lib/waterx-assets";
import { cachedFetch, fetchPythHistory } from "@/lib/perp-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/markets/quotes, live spot for EVERY market in one call, behind the
 * shared last-good cache. The whole batch is one cache key, so Pyth is swept at
 * most once per window across all users; on failure the last-good map is served
 * so picker prices never blank.
 */
type Q = { spot: number; change24h: number };

// Spot + 24h change from one Pyth hourly sweep: latest close vs the close ~24
// candles back (25 for a small buffer), matching refreshQuoteCache().
async function quoteFor(symbol: string): Promise<Q | null> {
  try {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 3600 * 30;
    const j = await fetchPythHistory(symbol, "60", from, to);
    const cl = j?.c ?? [];
    const ts = j?.t ?? [];
    if (!cl.length) return null;
    const spot = cl[cl.length - 1];
    // Pick the latest candle at or before 24h ago by timestamp — robust to
    // sparse/irregular candle counts (a fixed close[-25] index is not).
    const cutoff = to - 86400;
    let prevIdx = 0;
    for (let i = cl.length - 1; i >= 0; i--) { if ((ts[i] ?? 0) <= cutoff) { prevIdx = i; break; } }
    const prev = cl[prevIdx] || spot;
    return { spot, change24h: prev ? ((spot - prev) / prev) * 100 : 0 };
  } catch {
    return null;
  }
}

export async function GET() {
  if (!WATERX_ENABLED) return NextResponse.json({ quotes: {}, changes: {} }, { status: 503 });

  const { data } = await cachedFetch<Record<string, Q>>("perp:quotes:all:v2", 5000, async () => {
    const results = await Promise.all(WATERX_TICKERS.map(async (t) => [t, await quoteFor(t)] as const));
    const quotes: Record<string, Q> = {};
    for (const [t, q] of results) if (q != null && q.spot > 0) quotes[t] = q;
    // Only cache a non-trivial sweep; a fully-empty result means Pyth was down,
    // so return null to keep the prior good map.
    return Object.keys(quotes).length ? quotes : null;
  });

  // Flat spot map (back-compat with the terminal) + a parallel change map.
  const quotes: Record<string, number> = {};
  const changes: Record<string, number> = {};
  for (const [t, q] of Object.entries(data ?? {})) { quotes[t] = q.spot; changes[t] = q.change24h; }

  return NextResponse.json(
    { quotes, changes },
    { headers: { "Cache-Control": "public, max-age=4, stale-while-revalidate=30" } },
  );
}
