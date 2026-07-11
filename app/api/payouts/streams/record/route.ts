import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { teamStreamsEnabled, activateTeamStream } from "@/lib/team-streams";

export const runtime = "nodejs";

/**
 * POST /api/payouts/streams/record — { streamId, digest }
 *
 * Activate a drafted team stream once the funding send has landed in the escrow.
 * The first tranche becomes due one interval from now; the cron takes it from there.
 */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  if (!teamStreamsEnabled()) return NextResponse.json({ error: "Team streaming isn't available yet." }, { status: 503 });

  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  let body: { streamId?: string; digest?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const streamId = (body.streamId ?? "").trim();
  const digest = (body.digest ?? "").trim();
  if (!streamId || !digest) return NextResponse.json({ error: "missing streamId or digest" }, { status: 400 });

  const stream = await activateTeamStream(streamId, userId, digest);
  if (!stream) return NextResponse.json({ error: "stream not found" }, { status: 404 });
  return NextResponse.json({ stream });
}
