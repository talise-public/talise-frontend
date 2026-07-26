import { NextResponse } from "next/server";
import { ensureAnalyticsSchema, getRecentTxPage } from "@/lib/analytics/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/transactions — one page of the public transaction feed.
 *
 * Query params:
 *   • limit  — page size (1–100, default 60)
 *   • offset — rows to skip (default 0)
 *   • q      — optional free-text filter (handle / address / counterparty /
 *              direction / digest)
 *
 * Returns { rows, total, limit, offset } where `total` is the row count for the
 * current filter, so the /analytics table can page through EVERY indexed
 * transaction (not just the newest 60). Public, on-chain data only. Edge-cached
 * briefly so paging feels instant without hammering Postgres.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get("limit") ?? "60");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const q = url.searchParams.get("q") ?? "";

    await ensureAnalyticsSchema();
    const { rows, total } = await getRecentTxPage({ limit, offset, q });

    return NextResponse.json(
      { rows, total, limit, offset },
      {
        headers: {
          "Cache-Control": "public, s-maxage=15, stale-while-revalidate=60",
        },
      },
    );
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
