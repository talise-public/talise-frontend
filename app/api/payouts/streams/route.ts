import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { teamStreamsEnabled, listTeamStreams } from "@/lib/team-streams";

export const runtime = "nodejs";

/**
 * GET /api/payouts/streams, the caller's team streams (newest first), with progress.
 *
 * Each row carries `dueNow` — the client fires those on app-open via
 * /[id]/release → sign → /[id]/released (there is no cron). `legacy: true` marks a
 * pre-on-chain escrow-era stream, which the trigger never touches.
 */
export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;

  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  if (!teamStreamsEnabled()) return NextResponse.json({ streams: [] });
  const streams = await listTeamStreams(userId);
  return NextResponse.json({ streams });
}
