import { NextResponse } from "next/server";
import { WATERX_ENABLED } from "@/lib/waterx";
import { cachedFetch, fetchPythHistory } from "@/lib/perp-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RES: Record<string, string> = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" };
const SECS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
type Candle = { time: number; open: number; high: number; low: number; close: number };

/**
 * GET /api/markets/candles?symbol=SUIUSD&interval=15m, OHLC candles for the
 * chart, from Pyth Benchmarks, behind a shared last-good cache so a flaky
 * upstream never blanks the chart (see lib/perp-cache).
 */
export async function GET(req: Request) {
  if (!WATERX_ENABLED) return NextResponse.json({ error: "disabled" }, { status: 503 });
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol") ?? "BTCUSD";
  const interval = url.searchParams.get("interval") ?? "15m";
  const res = RES[interval];
  if (!res) return NextResponse.json({ error: "bad interval" }, { status: 400 });

  const to = Math.floor(Date.now() / 1000);
  // Pyth caps a single request at 1 year; cap the lookback to ~360 days so 1d
  // works while shorter intervals are untouched.
  const from = to - Math.min((SECS[interval] ?? 900) * 400, 360 * 86400);

  const { data, stale } = await cachedFetch<Candle[]>(
    `perp:candles:${symbol}:${interval}`,
    // Fresh window: shorter intervals refresh faster; all are served from cache
    // between windows so Pyth is hit at most once per key per window globally.
    interval === "1m" ? 8000 : interval === "5m" ? 20000 : 45000,
    async () => {
      const j = await fetchPythHistory(symbol, res, from, to);
      if (!j?.t?.length) return null;
      return j.t.map((time, i) => ({ time, open: j.o![i], high: j.h![i], low: j.l![i], close: j.c![i] }));
    },
  );

  return NextResponse.json(
    { candles: data ?? [], stale, unavailable: data == null },
    { headers: { "Cache-Control": "public, max-age=3, stale-while-revalidate=30" } },
  );
}
