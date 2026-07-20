import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-auth";
import { ensureSchema } from "@/lib/db";
import { getSummary } from "@/lib/analytics/store";
import type { AnalyticsSummary } from "@/lib/analytics/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/summary, the cached on-chain AnalyticsSummary.
 *
 * Reads whatever the indexer has persisted so far (analytics_user_stats +
 * analytics_recent_tx + analytics_index_state) and returns REAL totals,
 * the newest-tx feed, and index progress. Admin-gated: this exposes ALL
 * users' financial data.
 */
export async function GET(req: Request): Promise<Response> {
  const denied = await requireAdminApi(req);
  if (denied) return denied;

  try {
    await ensureSchema();
    const summary: AnalyticsSummary = await getSummary();
    return NextResponse.json(summary);
  } catch (err) {
    return NextResponse.json(
      { error: "failed to load analytics summary", detail: String(err) },
      { status: 500 }
    );
  }
}
