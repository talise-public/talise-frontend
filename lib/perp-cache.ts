import { db } from "@/lib/db";
import { pythSymbolFor } from "@/lib/waterx-assets";

/**
 * Shared last-good cache for the perps price feeds (candles / quotes).
 *
 * Pyth Benchmarks rate-limits Vercel's egress IPs, so a per-request `no-store`
 * fetch fails intermittently, the chart blanks and the 24h change reads 0.
 * This wraps every Pyth read so that:
 *   1. a FRESH cached value (age < freshMs) is served without touching Pyth -
 *      collapsing all users onto one upstream call per key per window, which
 *      keeps us under the rate limit; and
 *   2. when Pyth does fail, the LAST-GOOD cached value is served (any age), so
 *      the client never sees empty data.
 *
 * Cache lives in Postgres `global_kv` (shared across serverless instances,
 * survives cold starts). Reads/writes are best-effort, a DB hiccup degrades to
 * a direct Pyth fetch, never a 500.
 */

type Cached<T> = { ts: number; data: T };

async function readCache<T>(key: string): Promise<Cached<T> | null> {
  try {
    const r = await db().execute({
      sql: "SELECT v_text, refreshed_at FROM global_kv WHERE k = ?",
      args: [key],
    });
    const row = r.rows[0] as { v_text?: string; refreshed_at?: number | string } | undefined;
    if (!row?.v_text) return null;
    return { ts: Number(row.refreshed_at) || 0, data: JSON.parse(row.v_text) as T };
  } catch {
    return null;
  }
}

async function writeCache<T>(key: string, data: T): Promise<void> {
  try {
    await db().execute({
      sql: `INSERT INTO global_kv (k, v_text, refreshed_at) VALUES (?, ?, ?)
            ON CONFLICT (k) DO UPDATE SET v_text = EXCLUDED.v_text, refreshed_at = EXCLUDED.refreshed_at`,
      args: [key, JSON.stringify(data), Date.now()],
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Serve `key` from cache when fresh, else fetch; on fetch failure fall back to
 * the last-good cached value. `fetchFn` returns null to signal "no usable data"
 * (treated like a failure, keeps the prior good value instead of caching empty).
 */
export async function cachedFetch<T>(
  key: string,
  freshMs: number,
  fetchFn: () => Promise<T | null>,
): Promise<{ data: T | null; stale: boolean }> {
  const cached = await readCache<T>(key);
  if (cached && Date.now() - cached.ts < freshMs) {
    return { data: cached.data, stale: false };
  }
  try {
    const fresh = await fetchFn();
    if (fresh != null) {
      await writeCache(key, fresh);
      return { data: fresh, stale: false };
    }
  } catch {
    /* fall through to stale */
  }
  if (cached) return { data: cached.data, stale: true };
  return { data: null, stale: false };
}

/**
 * Best-effort live spot for a symbol from the warm cache (per-symbol quote, then
 * the batch). Used to price open positions from our reliable feed instead of the
 * on-chain oracle_price (which is high-precision-scaled and can lag).
 */
export async function cachedSpotFor(symbol: string): Promise<number | null> {
  const q = await readCache<{ spot: number; change24h: number }>(`perp:quote:${symbol}`);
  if (q && typeof q.data?.spot === "number" && q.data.spot > 0) return q.data.spot;
  const all = await readCache<Record<string, number>>("perp:quotes:all");
  const s = all?.data?.[symbol];
  return typeof s === "number" && s > 0 ? s : null;
}

const RES: Record<string, string> = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" };
const SECS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
export const WARM_INTERVALS = Object.keys(RES);

/**
 * Fetch candles for (symbol, interval) and write them to the cache. Used by the
 * warm cron so every key is populated even when no user has viewed it yet, and
 * once populated, the last-good value survives any later Pyth outage.
 */
export async function refreshCandleCache(symbol: string, interval: string): Promise<boolean> {
  const res = RES[interval];
  if (!res) return false;
  const to = Math.floor(Date.now() / 1000);
  const from = to - Math.min((SECS[interval] ?? 900) * 400, 360 * 86400);
  try {
    const j = await fetchPythHistory(symbol, res, from, to);
    if (!j?.t?.length) return false;
    const candles = j.t.map((time, i) => ({ time, open: j.o![i], high: j.h![i], low: j.l![i], close: j.c![i] }));
    await writeCache(`perp:candles:${symbol}:${interval}`, candles);
    return true;
  } catch {
    return false;
  }
}

/** Fetch spot + 24h change for `symbol` and write it to the cache. */
export async function refreshQuoteCache(symbol: string): Promise<boolean> {
  try {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 3600 * 30;
    const j = await fetchPythHistory(symbol, "60", from, to);
    const cl = j?.c ?? [];
    if (!cl.length) return false;
    const spot = cl[cl.length - 1];
    const prev = cl[Math.max(0, cl.length - 25)] || spot;
    await writeCache(`perp:quote:${symbol}`, { spot, change24h: prev ? ((spot - prev) / prev) * 100 : 0 });
    return true;
  } catch {
    return false;
  }
}

/** Fetch Pyth Benchmarks TradingView history with a timeout + one retry. */
export async function fetchPythHistory(
  symbol: string,
  resolution: string,
  from: number,
  to: number,
): Promise<{ s: string; t?: number[]; o?: number[]; h?: number[]; l?: number[]; c?: number[] } | null> {
  const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=${encodeURIComponent(
    pythSymbolFor(symbol),
  )}&resolution=${resolution}&from=${from}&to=${to}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const j = (await r.json()) as { s: string; t?: number[]; c?: number[] };
      if (j.s === "ok" && j.t?.length) return j as never;
      return null; // valid response, genuinely no data
    } catch {
      /* retry once */
    }
  }
  throw new Error("pyth history failed");
}
