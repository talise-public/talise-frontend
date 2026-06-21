import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/fx — USD-base FX rates for the currencies Talise displays.
 *
 * Powered by open.er-api.com (free, no key, ECB + central-bank data,
 * single endpoint). Cached server-side for 1 hour so a single user
 * scrolling between Home / Earn / Send doesn't fan out RPC.
 *
 * Response: { base: "USD", asOf: <iso>, rates: { USD: 1, NGN: …, … } }
 *
 * Talise displays USDsui as $1 (1:1 USD peg). When a user picks NGN
 * in Profile preferences, iOS multiplies their USDsui balance by
 * rates.NGN to render "₦310" instead of "$0.20".
 */
// Must stay in sync with iOS `TaliseCurrency.allSupported`. The Asian /
// global corridor currencies (JPY…VND) were added to the app picker but
// were MISSING here, so picking them fell back to rate 1.0 and rendered the
// raw USD figure with the wrong symbol (e.g. "¥0.20"). open.er-api.com
// returns real rates for all of these.
const SUPPORTED = [
  "USD", "NGN", "GHS", "KES", "EUR", "GBP", "CAD", "ZAR",
  "JPY", "SGD", "PHP", "IDR", "VND",
] as const;

let cache:
  | { ts: number; payload: { base: string; asOf: string; rates: Record<string, number> } }
  | null = null;
const TTL_MS = 60 * 60 * 1000;

/** Primary: open.er-api.com (ECB + central-bank, USD-keyed, uppercase). */
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
    asOf: new Date(
      (data.time_last_update_unix ?? Date.now() / 1000) * 1000
    ).toISOString(),
  };
}

/** Fallback: fawazahmed0 currency-api (free, no key, lowercase codes). */
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

export async function GET() {
  if (cache && Date.now() - cache.ts < TTL_MS) {
    return NextResponse.json(cache.payload);
  }
  // Try the primary feed, then the fallback. Only soft-fail to USD-only
  // when BOTH are unreachable — a single flaky upstream must not strip the
  // app down to "$" display (the conversion-fails symptom).
  let result: { rates: Record<string, number>; asOf: string } | null = null;
  try {
    result = await fetchPrimary();
  } catch (errPrimary) {
    console.warn(`[api/fx] primary failed: ${(errPrimary as Error).message}`);
    try {
      result = await fetchFallback();
    } catch (errFallback) {
      console.warn(`[api/fx] fallback failed: ${(errFallback as Error).message}`);
    }
  }

  // Require at least one real (non-USD) rate before caching — a degenerate
  // {USD:1}-only response from a half-broken upstream would otherwise poison
  // the 1h cache and make conversion silently fail for everyone.
  if (result && Object.keys(result.rates).some((c) => c !== "USD")) {
    result.rates.USD = 1;
    const payload = { base: "USD", asOf: result.asOf, rates: result.rates };
    cache = { ts: Date.now(), payload };
    return NextResponse.json(payload);
  }

  // Both upstreams unavailable — serve the last good cache if we have one,
  // even if stale, rather than collapsing to USD-only.
  if (cache) {
    return NextResponse.json({ ...cache.payload, stale: true });
  }
  return NextResponse.json({
    base: "USD",
    asOf: new Date().toISOString(),
    rates: { USD: 1 },
    error: "fx upstream unavailable",
  });
}
