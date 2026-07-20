import { NextResponse } from "next/server";
import { WATERX_ENABLED, listMarkets, type MarketSnapshot } from "@/lib/waterx";
import { cachedFetch } from "@/lib/perp-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/markets, live WaterX perp markets on Sui mainnet (read-only).
 *
 * No signer, no funds: each market is read via gRPC `simulateTransaction`.
 * Gated behind FEATURE_PERPS → 503 when disabled.
 */
export async function GET() {
  if (!WATERX_ENABLED) {
    return NextResponse.json(
      { error: "Perps aren't enabled.", code: "PERPS_DISABLED" },
      { status: 503 },
    );
  }
  try {
    // Market metadata + OI change slowly; cache the 30-gRPC list ~15s (shared
    // across users, with last-good on a gRPC blip) so it isn't re-read per hit.
    const { data: markets } = await cachedFetch<MarketSnapshot[]>(
      "perp:markets:list", 15000, async () => {
        const m = await listMarkets();
        return m.some((x) => !x.paused) ? m : null; // don't cache an all-failed read
      },
    );
    if (!markets) return NextResponse.json({ error: "read failed" }, { status: 502 });
    return NextResponse.json(
      { venue: "WaterX", network: "mainnet", collateral: "USDsui", markets },
      { headers: { "Cache-Control": "public, max-age=5, stale-while-revalidate=15" } },
    );
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message ?? "read failed" }, { status: 502 });
  }
}
