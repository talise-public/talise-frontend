import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * RETIRED, no cron.
 *
 * On the on-chain cheque rail, an expired-unclaimed cheque is reclaimed by the
 * CREATOR on demand (`cheque::reclaim`, surfaced in the wallet's "Mine" tab) -
 * there is nothing to sweep on a schedule. This route is removed from
 * vercel.json and left inert (410). `sweepExpiredCheques` remains in lib/cheques
 * for any manual/admin use.
 */
export async function GET() {
  return NextResponse.json(
    { error: "gone", detail: "cheque expiry is on-chain creator reclaim now; no sweep cron" },
    { status: 410 }
  );
}
