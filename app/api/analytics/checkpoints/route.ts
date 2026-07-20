import { NextResponse } from "next/server";
import { ensureAnalyticsSchema, getSnapshots } from "@/lib/analytics/store";
import { getPublicAnalytics } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/checkpoints — public, aggregate-only.
 *
 * Returns the live metrics plus the append-only checkpoint history (the
 * /analytics timeline). No auth, no PII. Edge-cached 60s so the public page and
 * any pollers don't hammer Postgres.
 */
export async function GET() {
  try {
    await ensureAnalyticsSchema();
    const [current, checkpoints] = await Promise.all([
      getPublicAnalytics(),
      getSnapshots(90),
    ]);
    return NextResponse.json(
      { current, checkpoints, updatedAt: new Date().toISOString() },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      }
    );
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
