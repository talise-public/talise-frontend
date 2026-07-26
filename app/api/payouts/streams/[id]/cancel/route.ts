import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import {
  teamStreamsEnabled,
  prepareCancelTeamStream,
  recordTeamStreamCancelled,
} from "@/lib/team-streams";

export const runtime = "nodejs";

/**
 * POST /api/payouts/streams/[id]/cancel — STEP 1 of stopping a stream.
 *
 * Returns the creator-signed, Onara-sponsored `team_stream::cancel` bytes; signing
 * them stops the stream and refunds the ENTIRE remaining pot (unreleased tranches
 * plus the rounding dust) to the creator in that same transaction. The client then
 * posts the digest to /api/payouts/streams/[id]/cancelled to close the mirror.
 *
 * A draft (nothing funded yet) or a legacy escrow-era row has no on-chain object,
 * so there's nothing to sign: the mirror is closed immediately and the response
 * says `mode: "recorded"`.
 *
 * Ownership-gated and idempotent.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const streamId = (id ?? "").trim();
  if (!streamId) return NextResponse.json({ error: "missing stream id" }, { status: 400 });

  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  if (!teamStreamsEnabled()) return NextResponse.json({ error: "Team streaming isn't available yet." }, { status: 503 });

  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  try {
    const prepared = await prepareCancelTeamStream(streamId, userId);
    if (prepared) return NextResponse.json({ mode: "onchain", bytes: prepared.bytes });
    // Nothing on chain to refund — just close the row.
    const stream = await recordTeamStreamCancelled(streamId, userId, null);
    if (!stream) return NextResponse.json({ error: "stream not found" }, { status: 404 });
    return NextResponse.json({ mode: "recorded", stream });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message ?? "couldn't prepare the cancel" }, { status: 400 });
  }
}
