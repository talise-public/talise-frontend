import { NextResponse } from "next/server";
import { ensureAnalyticsSchema, getSummary } from "@/lib/analytics/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/network — public network dashboard data.
 *
 * Returns the same AnalyticsSummary the admin dashboard uses (totals + the
 * recent on-chain transaction feed + indexing freshness), but with NO admin
 * gate: the public /analytics page renders Talise's on-chain activity for
 * anyone. Everything here is already public on-chain data (Sui digests,
 * SuiNS-resolvable handles, addresses); shielded private-send amounts stay
 * null/hidden. Edge-cached 30s so it never hammers Postgres.
 */
export async function GET() {
  try {
    await ensureAnalyticsSchema();
    const data = await getSummary();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120",
      },
    });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
