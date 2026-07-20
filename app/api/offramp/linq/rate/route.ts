import { NextResponse } from "next/server";

import { getRate, linqConfigured } from "@/lib/linq";

export const runtime = "nodejs";

/**
 * GET /api/offramp/linq/rate
 *
 * Public display rate (1 USDSUI = `rate` NGN). No auth, mirrors Linq's own
 * public /b2b/rate. Lets the cash-out UI show a live "≈ ₦X" estimate as the
 * user types the amount. The order locks its own rate at creation time, so
 * this is display-only.
 */
export async function GET() {
  if (!linqConfigured()) {
    return NextResponse.json({ error: "off-ramp not configured" }, { status: 503 });
  }
  try {
    const r = await getRate();
    return NextResponse.json(r);
  } catch {
    return NextResponse.json({ error: "rate_unavailable" }, { status: 503 });
  }
}
