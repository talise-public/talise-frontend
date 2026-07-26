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
  buildStreamPauseSponsored,
} from "@/lib/streams";

export const runtime = "nodejs";

/**
 * POST /api/streams/[id]/pause
 *
 * Sender-only. STEP 1 of a pause: returns Onara-SPONSORED bytes for the sender
 * to sign, then POST the digest to /api/streams/[id]/confirm.
 *
 * The pause is ON CHAIN, not a row flip. That matters because `claim_accrued` is
 * permissionless: only the contract's `paused` flag actually stops money moving.
 * A mirror-only pause would leave the stream claimable by anyone who can build
 * the PTB, which is not a pause at all.
 *
 * The PTB settles accrued tranches BEFORE pausing (see
 * `buildStreamPauseSponsored`), so pausing never claws back money the Clock has
 * already earned the recipient.
 *
 * The row flips to `paused` immediately, before the signature lands. That is the
 * fail-safe direction: it stops the app-open auto-fire from pushing the stream
 * while the sender is mid-signature, and the money simply stays locked in the
 * Stream object either way. `confirm` then reconciles the row to the chain.
 *
 * Idempotent: pausing a paused or terminal stream is a no-op.
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

  // Terminal (including DERIVED completed) is immutable, and an already-paused
  // stream needs nothing done. Either way there is nothing to sign.
  const p = projectStream(row);
  if (p.state === "completed" || p.state === "cancelled" || p.state === "paused") {
    return NextResponse.json({ ok: true, state: p.state, stream: p });
  }

  if (!streamOnchainEnabled() || !isOnchainStreamId(id)) {
    // Legacy `str_…` row with no Stream object: the mirror is all there is.
    await setStreamState(id, "paused");
    return NextResponse.json({ ok: true, state: "paused" });
  }

  // Stop the auto-fire trigger first (fail-safe), then hand back the bytes.
  await setStreamState(id, "paused");

  try {
    const { bytes, sponsor } = await buildStreamPauseSponsored({
      senderAddress: row.sender_address,
      streamObjectId: id,
      claimableTranches: p.claimableTranches,
    });
    return NextResponse.json({ ok: true, state: "paused", mode: "onchain", bytes, sponsor });
  } catch (err) {
    const msg = (err as Error).message ?? "pause build failed";
    console.warn(`[streams/pause] build failed stream=${id}: ${msg}`);
    // The row is paused regardless, so Talise stops pushing the stream. Surface
    // a non-fatal note; resuming and re-pausing is safe to retry.
    return NextResponse.json({
      ok: true,
      state: "paused",
      mode: "onchain",
      onchainPending: true,
      detail: msg,
    });
  }
}
