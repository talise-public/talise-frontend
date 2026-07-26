import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { requireAppAttestStructural } from "@/lib/app-attest";
import { rateLimitAsync } from "@/lib/rate-limit";
import {
  streamById,
  setStreamState,
  projectStream,
  streamOnchainEnabled,
  isOnchainStreamId,
  buildStreamResumeSponsored,
} from "@/lib/streams";

export const runtime = "nodejs";

/**
 * POST /api/streams/[id]/resume
 *
 * Sender-only. STEP 1 of a resume: returns Onara-SPONSORED `stream::resume`
 * bytes for the sender to sign, then POST the digest to
 * /api/streams/[id]/confirm, which reads the contract's now-false `paused` flag
 * and flips the row back to `active`.
 *
 * Unlike pause, the row is NOT flipped up front. Same fail-safe reasoning, other
 * direction: marking a stream active while the chain still has it paused would
 * make the app-open auto-fire hammer a `claim_accrued` that can only abort with
 * `EPaused`. So the mirror stays paused until the chain says otherwise.
 *
 * The schedule keeps its ORIGINAL timing, so a long pause leaves several
 * tranches immediately due and the next auto-fire claim drains them in one call.
 *
 * Idempotent: resuming an active or terminal stream is a no-op.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const attest = requireAppAttestStructural(req);
  if (attest) return attest;

  const rl = await rateLimitAsync({
    key: `streams-resume:user:${userId}`,
    limit: 60,
    windowSec: 3600,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }

  const { id } = await params;
  const row = await streamById(id);
  if (!row) {
    return NextResponse.json({ error: "stream not found" }, { status: 404 });
  }
  if (row.sender_user_id !== userId) {
    return NextResponse.json({ error: "only the sender can resume" }, { status: 403 });
  }

  const p = projectStream(row);
  if (p.state === "completed" || p.state === "cancelled" || p.state === "active") {
    return NextResponse.json({ ok: true, state: p.state, stream: p });
  }

  if (!streamOnchainEnabled() || !isOnchainStreamId(id)) {
    // Legacy `str_…` row with no Stream object: the mirror is all there is.
    await setStreamState(id, "active");
    return NextResponse.json({ ok: true, state: "active" });
  }

  try {
    const { bytes, sponsor } = await buildStreamResumeSponsored({
      senderAddress: row.sender_address,
      streamObjectId: id,
    });
    return NextResponse.json({ ok: true, mode: "onchain", bytes, sponsor, state: "paused" });
  } catch (err) {
    const msg = (err as Error).message ?? "resume build failed";
    console.warn(`[streams/resume] build failed stream=${id}: ${msg}`);
    return NextResponse.json(
      { error: "Couldn't prepare the resume right now.", detail: msg },
      { status: 502 }
    );
  }
}
