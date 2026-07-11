import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { teamStreamsEnabled, cancelTeamStream } from "@/lib/team-streams";

export const runtime = "nodejs";

/**
 * POST /api/payouts/streams/[id]/cancel — stop a stream and refund the unspent
 * remainder to the sender (gasless escrow send). Idempotent + ownership-gated.
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

  const stream = await cancelTeamStream(streamId, userId);
  if (!stream) return NextResponse.json({ error: "stream not found" }, { status: 404 });
  return NextResponse.json({ stream });
}
