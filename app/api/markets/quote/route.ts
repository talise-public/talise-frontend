import { NextResponse } from "next/server";
import { WATERX_ENABLED } from "@/lib/waterx";
import { cachedFetch, fetchPythHistory } from "@/lib/perp-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Q = { spot: number; change24h: number };

/**
 * GET /api/markets/quote?symbol=SUIUSD, live spot + 24h change from Pyth
 * Benchmarks hourly closes, behind the shared last-good cache so the header
 * price + change never fall back to 0 when Pyth rate-limits Vercel.
 */
export async function GET(req: Request) {
  if (!WATERX_ENABLED) return NextResponse.json({ error: "disabled" }, { status: 503 });
  const symbol = new URL(req.url).searchParams.get("symbol") ?? "BTCUSD";

  const { data } = await cachedFetch<Q>(`perp:quote:${symbol}`, 4000, async () => {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 3600 * 30; // 30h of hourly bars
    const j = await fetchPythHistory(symbol, "60", from, to);
    const cl = j?.c ?? [];
    if (!cl.length) return null;
    const spot = cl[cl.length - 1];
    const prev = cl[Math.max(0, cl.length - 25)] || spot; // ~24h ago
    return { spot, change24h: prev ? ((spot - prev) / prev) * 100 : 0 };
  });

  if (!data) return NextResponse.json({ unavailable: true });
  return NextResponse.json(data, {
    headers: { "Cache-Control": "public, max-age=3, stale-while-revalidate=15" },
  });
}
