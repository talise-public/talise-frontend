import { NextResponse } from "next/server";
import { getQuote } from "@/lib/fx-feed";
import { isCurrency, type Currency } from "@/lib/fx";
import { getClientIp, rateLimitAsync } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-authoritative FX quote endpoint (cross-border master plan §6, §11).
 *
 * The single place clients (iOS cross-border send, the offramp flow) get a
 * locked, executable quote. Pricing — mid-market off the live feed minus
 * the corridor's volatility-tier spread — lives entirely server-side so a
 * client can never self-price. The returned quote carries an `expiresAt`;
 * the commit path must re-validate freshness before settling.
 *
 * POST { from, to, amount }
 *   200 → { quote }                        (locked, spread-inclusive)
 *   400 → bad currency / bad amount
 *   503 → STALE_FEED / SNAPSHOT_ONLY       (circuit breaker — fail over,
 *         do NOT serve a stale price; caller retries or settles in USDC)
 *
 * Rate-limited per IP — quotes are an FX-scraping surface.
 */
export async function POST(req: Request) {
  const ip = getClientIp(req);
  const rl = await rateLimitAsync({ key: `fx-quote:${ip}`, limit: 60, windowSec: 60 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many quote requests." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } }
    );
  }

  let body: { from?: unknown; to?: unknown; amount?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const from = body.from;
  const to = body.to;
  if (!isCurrency(from) || !isCurrency(to)) {
    return NextResponse.json(
      { error: "from/to must be supported currency codes", code: "UNSUPPORTED_CURRENCY" },
      { status: 400 }
    );
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { error: "amount must be a positive number", code: "BAD_AMOUNT" },
      { status: 400 }
    );
  }

  const result = await getQuote(from as Currency, to as Currency, amount);
  if (result.ok) {
    return NextResponse.json({ quote: result.quote });
  }

  // Circuit-breaker errors are transient pricing-unavailable (503); input
  // errors are 400.
  const transient = result.error === "STALE_FEED" || result.error === "SNAPSHOT_ONLY";
  return NextResponse.json(
    { error: result.message, code: result.error },
    { status: transient ? 503 : 400 }
  );
}
