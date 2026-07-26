import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import { teamStreamsEnabled, prepareReleaseTeamStream } from "@/lib/team-streams";

export const runtime = "nodejs";

/**
 * POST /api/payouts/streams/[id]/release — the "fire due streams on app-open"
 * trigger, exactly mirroring /api/rules/[id]/execute.
 *
 * Returns the Onara-sponsored, PERMISSIONLESS `team_stream::release_due_tranche`
 * bytes for a stream the caller owns. The client signs them (creator is the
 * sender) and posts to /api/zk/sponsor-execute, then calls
 * /api/payouts/streams/[id]/released with the digest. There is NO cron.
 *
 * The contract gates the actual payout on the Clock + the funded schedule, so
 * signing a not-yet-due stream simply aborts ENotDue, a finished one EExhausted,
 * and a cancelled one ECancelled. Firing the same tranche twice is impossible.
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

  const rl = await rateLimitAsync({ key: `team-stream-release:user:${userId}`, limit: 240, windowSec: 3600 });
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } });
  }

  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  try {
    const prepared = await prepareReleaseTeamStream(streamId, userId);
    if (!prepared) {
      return NextResponse.json({ error: "stream has no on-chain pot to release", code: "NO_STREAM" }, { status: 409 });
    }
    return NextResponse.json({ mode: "onchain", bytes: prepared.bytes });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message ?? "couldn't prepare the release" }, { status: 400 });
  }
}
