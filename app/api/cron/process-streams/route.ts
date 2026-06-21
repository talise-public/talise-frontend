import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RETIRED — streaming is now on-chain and Clock-based.
 *
 * There is no scheduler anymore. A stream is a real `Stream<USDSUI>` Move
 * object; the recipient pulls every tranche the on-chain `Clock` says is due
 * by calling `stream::claim_accrued` (POST /api/streams/[id]/claim, signed by
 * the recipient, gas sponsored by Onara). No worker key, no cron.
 *
 * This route is removed from vercel.json and left as an inert 410 so a stray
 * ping can't trigger anything. The old escrow-scheduler logic lives in git
 * history if ever needed.
 */
export async function GET() {
  return NextResponse.json(
    {
      error: "gone",
      detail:
        "Stream release is on-chain (stream::claim_accrued via /api/streams/[id]/claim). No scheduler.",
    },
    { status: 410 }
  );
}
