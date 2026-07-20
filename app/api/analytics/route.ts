import { NextResponse } from "next/server";
import { getPublicAnalytics } from "@/lib/analytics";

export const dynamic = "force-dynamic";

/**
 * GET /api/analytics, public, aggregate-only product metrics.
 *
 * No auth, no PII. Cached at the edge for 60s (stale-while-revalidate 300s) so
 * a burst of traffic to the public page doesn't hammer Postgres. Every figure
 * is a live count/sum from production.
 */
export async function GET() {
  try {
    const data = await getPublicAnalytics();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
