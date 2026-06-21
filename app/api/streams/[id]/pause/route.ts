import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { requireAppAttestStructural } from "@/lib/app-attest";
import { rateLimitAsync } from "@/lib/rate-limit";
import { streamById, setStreamState } from "@/lib/streams";

export const runtime = "nodejs";

/**
 * POST /api/streams/[id]/pause
 *
 * Sender-only. Flips the stream's state to `paused` so the scheduler stops
 * releasing tranches. The escrow keeps the funds; resume picks up from the
 * cursor (the next_tranche_at the row already holds). Idempotent: pausing an
 * already-paused (or terminal) stream is a no-op.
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
    key: `streams-pause:user:${userId}`,
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
    return NextResponse.json({ error: "only the sender can pause" }, { status: 403 });
  }
  // Terminal states are immutable; an already-paused stream is a no-op.
  if (row.state === "completed" || row.state === "cancelled") {
    return NextResponse.json({ ok: true, state: row.state });
  }
  if (row.state === "active" || row.state === "stalled") {
    await setStreamState(id, "paused");
  }
  return NextResponse.json({ ok: true, state: "paused" });
}
