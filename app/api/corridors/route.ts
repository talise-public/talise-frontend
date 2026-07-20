import { NextResponse } from "next/server";

import { listCorridors, type Corridor } from "@/lib/corridors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/corridors, the cross-border corridor registry for the client.
 *
 * Exposes the live + planned corridors so the app can render which fiat
 * routes are available now ("live"), in flight behind a partner
 * ("partner"), or on the roadmap ("planned"). The chain stays invisible:
 * the client only ever sees `fromCcy`/`toCcy` fiat and the lifecycle
 * status, never USDsui/USDC settlement.
 *
 * The registry is static metadata (no I/O), so the only thing this route
 * does is shape it for the wire. We split out `live` for convenience
 * (the set callers can actually transact on) while still returning the
 * full registry so the UI can show "coming soon" corridors.
 *
 * Response:
 *   {
 *     asOf: <iso>,
 *     count: <n>,
 *     corridors: Corridor[],            // full registry
 *     live: Corridor[],                 // status === "live"
 *     planned: Corridor[]               // status === "planned"
 *   }
 *
 * Note: `licenseNote` is intentionally included, it is non-secret ops
 * metadata and lets the client surface the right compliance copy
 * (e.g. the ¥1M JPY cap) without a second round-trip.
 */
export async function GET() {
  const corridors = listCorridors();
  const byStatus = (s: Corridor["status"]) =>
    corridors.filter((c) => c.status === s);

  return NextResponse.json({
    asOf: new Date().toISOString(),
    count: corridors.length,
    corridors,
    live: byStatus("live"),
    planned: byStatus("planned"),
  });
}
