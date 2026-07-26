import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { teamStreamsEnabled, recordTeamStreamCancelled } from "@/lib/team-streams";

export const runtime = "nodejs";

const DIGEST_RE = /^[1-9A-HJ-NP-Za-km-z]{40,60}$/;

/**
 * POST /api/payouts/streams/[id]/cancelled, { digest } — STEP 2 of a cancel.
 *
 * Records a confirmed on-chain `team_stream::cancel` (the refund already landed in
 * the creator's wallet inside that transaction). Verifies the digest touched this
 * stream before closing the mirror. If a client never gets here the chain is still
 * authoritative: a later release trigger just aborts ECancelled and is skipped.
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

  let body: { digest?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const digest = typeof body.digest === "string" ? body.digest.trim() : "";
  if (!DIGEST_RE.test(digest)) return NextResponse.json({ error: "a valid transaction digest is required" }, { status: 400 });

  try {
    const stream = await recordTeamStreamCancelled(streamId, userId, digest);
    if (!stream) return NextResponse.json({ error: "stream not found" }, { status: 404 });
    return NextResponse.json({ stream });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message ?? "couldn't record the cancel" }, { status: 400 });
  }
}
