import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { requireAppAttestStructural } from "@/lib/app-attest";
import { rateLimitAsync } from "@/lib/rate-limit";
import { streamById, setStreamState } from "@/lib/streams";

export const runtime = "nodejs";

/**
 * POST /api/streams/[id]/resume
 *
 * Sender-only. Flips a `paused` stream back to `active`. The schedule keeps
 * the ORIGINAL timing (next_tranche_at is unchanged), so a long pause makes
 * several tranches immediately due; the cron drains them one-per-tick (design
 * §3.4 pause semantics (a)). Idempotent.
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
  if (row.state === "completed" || row.state === "cancelled") {
    return NextResponse.json({ ok: true, state: row.state });
  }
  if (row.state === "paused" || row.state === "stalled") {
    await setStreamState(id, "active");
  }
  return NextResponse.json({ ok: true, state: "active" });
}
