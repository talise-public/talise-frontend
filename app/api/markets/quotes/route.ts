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
async function spotFor(symbol: string): Promise<number | null> {
  try {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 3600 * 4;
    const j = await fetchPythHistory(symbol, "60", from, to);
    const cl = j?.c ?? [];
    return cl.length ? cl[cl.length - 1] : null;
  } catch {
    return null;
  }
}

export async function GET() {
  if (!WATERX_ENABLED) return NextResponse.json({ quotes: {} }, { status: 503 });

  const { data } = await cachedFetch<Record<string, number>>("perp:quotes:all", 5000, async () => {
    const results = await Promise.all(WATERX_TICKERS.map(async (t) => [t, await spotFor(t)] as const));
    const quotes: Record<string, number> = {};
    for (const [t, s] of results) if (s != null && s > 0) quotes[t] = s;
    // Only cache a non-trivial sweep; a fully-empty result means Pyth was down,
    // so return null to keep the prior good map.
    return Object.keys(quotes).length ? quotes : null;
  });

  return NextResponse.json(
    { quotes: data ?? {} },
    { headers: { "Cache-Control": "public, max-age=4, stale-while-revalidate=30" } },
  );
}
