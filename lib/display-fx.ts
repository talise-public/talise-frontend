import "server-only";

import { FX, type Currency } from "@/lib/fx";

/**
 * The LIVE display FX rates — the exact numbers the app shows (Home, activity,
 * currency picker) via `/api/fx`. Extracted here so the agent converts local
 * amounts with the SAME rate the user sees, instead of the static `FX` snapshot.
 *
 * Source: open.er-api.com (primary) → fawazahmed0 (fallback), cached 1h.
 */

const SUPPORTED = [
  "USD", "NGN", "GHS", "KES", "EUR", "GBP", "CAD", "ZAR",
  "JPY", "SGD", "PHP", "IDR", "VND",
] as const;

export interface DisplayRates {
  base: string;
  asOf: string;
  rates: Record<string, number>;
  stale?: boolean;
  error?: string;
}

let cache: { ts: number; payload: DisplayRates } | null = null;
const TTL_MS = 60 * 60 * 1000;

async function fetchPrimary(): Promise<{ rates: Record<string, number>; asOf: string }> {
  const r = await fetch("https://open.er-api.com/v6/latest/USD", {
    next: { revalidate: 3600 },
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error(`open.er-api ${r.status}`);
  const data = await r.json();
  if (data.result !== "success") throw new Error("open.er-api rejected");
  const rates: Record<string, number> = {};
  for (const code of SUPPORTED) {
    const v = data.rates?.[code];
    if (typeof v === "number" && v > 0) rates[code] = v;
  }
  return {
    rates,
    asOf: new Date((data.time_last_update_unix ?? Date.now() / 1000) * 1000).toISOString(),
  };
}

async function fetchFallback(): Promise<{ rates: Record<string, number>; asOf: string }> {
  const r = await fetch(
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
    { next: { revalidate: 3600 }, signal: AbortSignal.timeout(4000) }
  );
  if (!r.ok) throw new Error(`fawazahmed0 ${r.status}`);
  const data = await r.json();
  const table = data.usd ?? {};
  const rates: Record<string, number> = {};
  for (const code of SUPPORTED) {
    const v = table[code.toLowerCase()];
    if (typeof v === "number" && v > 0) rates[code] = v;
  }
  return { rates, asOf: new Date((data.date ? Date.parse(data.date) : Date.now())).toISOString() };
}

/** The live display rate table (USD-base), cached 1h. Never throws. */
export async function getDisplayRates(): Promise<DisplayRates> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.payload;
  let result: { rates: Record<string, number>; asOf: string } | null = null;
  try {
    result = await fetchPrimary();
  } catch {
    try {
      result = await fetchFallback();
    } catch {
      /* both upstreams down */
    }
  }
  if (result && Object.keys(result.rates).some((c) => c !== "USD")) {
    result.rates.USD = 1;
    const payload: DisplayRates = { base: "USD", asOf: result.asOf, rates: result.rates };
    cache = { ts: Date.now(), payload };
    return payload;
  }
  if (cache) return { ...cache.payload, stale: true };
  return { base: "USD", asOf: new Date().toISOString(), rates: { USD: 1 }, error: "fx upstream unavailable" };
}

/**
 * Live local-currency units per $1 for one currency (e.g. ~1558 for NGN),
 * falling back to the static `FX` snapshot if the feed has no value.
 */
export async function displayRatePerUsd(currency: Currency): Promise<number> {
  const r = await getDisplayRates().catch(() => null);
  const live = r?.rates[currency];
  return typeof live === "number" && live > 0 ? live : FX[currency];
}
