import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { teamStreamsEnabled, activateTeamStream } from "@/lib/team-streams";

export const runtime = "nodejs";

/**
 * POST /api/payouts/streams/record, { streamId, digest }
 *
 * Activate a drafted team stream once the creator's signed `team_stream::create`
 * has landed. The on-chain `TeamStream` object id is parsed from that transaction,
 * so a stream can only activate if it really was funded on chain.
 *
 * The first tranche becomes due one interval from now, and from then on ANY caller
 * can release it permissionlessly — in practice the creator's app fires due
 * tranches when it opens. There is no cron.
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

  try {
    const stream = await activateTeamStream(streamId, userId, digest);
    if (!stream) return NextResponse.json({ error: "stream not found" }, { status: 404 });
    return NextResponse.json({ stream });
  } catch (err) {
    // e.g. "couldn't confirm the on-chain stream yet" — the client retries with
    // the SAME digest; activation is idempotent.
    return NextResponse.json({ error: (err as Error).message ?? "couldn't activate the stream" }, { status: 409 });
  }
}
