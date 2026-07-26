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
  buildStreamCancelSponsored,
} from "@/lib/streams";

export const runtime = "nodejs";

/**
 * POST /api/streams/[id]/cancel
 *
 * Sender-only, terminal. STEP 1: returns Onara-SPONSORED bytes for the sender to
 * sign (only their zkLogin can sign `cancel_and_withdraw`), then POST the digest
 * to /api/streams/[id]/confirm.
 *
 * The PTB settles accrued tranches to the recipient BEFORE withdrawing (see
 * `buildStreamCancelSponsored`), so cancelling can't claw back money the Clock
 * had already earned them, and the refund figure quoted here is the true
 * remainder rather than "everything nobody happened to claim yet".
 *
 * Order: flip state FIRST (stops the app-open auto-fire racing the refund), then
 * return the bytes. Idempotent: cancelling an already-cancelled stream no-ops.
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
    key: `streams-cancel:user:${userId}`,
    limit: 30,
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
    return NextResponse.json({ error: "only the sender can cancel" }, { status: 403 });
  }
  if (row.state === "cancelled") {
    return NextResponse.json({ ok: true, state: "cancelled", refunded: false });
  }

  // A PAUSED stream must not compose `claim_accrued` into the cancel PTB: the
  // contract aborts it with EPaused and would take the whole cancel down. Read
  // this BEFORE the state flip below.
  const wasPaused = row.state === "paused";
  const p = projectStream(row);

  // A stream that has already paid out every tranche is DONE, not cancellable.
  // Since `completed` is derived, flipping the row would persist `cancelled` and
  // permanently relabel a stream that in fact delivered in full.
  if (p.state === "completed") {
    return NextResponse.json({ ok: true, state: "completed", stream: p });
  }

  // Stop the app-open auto-fire from racing a claim against the refund.
  await setStreamState(id, "cancelled");

  // The remainder is total minus what the recipient WILL hold once this PTB
  // lands: already-released plus the accrued tranches the composed claim
  // settles. Quoting `total - released` alone would promise the sender back
  // money that is about to (correctly) go to the recipient.
  const settledMicros = BigInt(
    Math.round((wasPaused ? p.releasedUsd : p.accruedUsd) * 1e6)
  );
  const remainderMicros =
    BigInt(row.total_micros) - settledMicros > 0n
      ? BigInt(row.total_micros) - settledMicros
      : 0n;
  const refundUsd = Number(remainderMicros) / 1e6;

  // ── ON-CHAIN path: only the sender's zkLogin can sign cancel_and_withdraw.
  // Return Onara-SPONSORED cancel bytes for the client to sign + execute. The
  // row is already flipped to cancelled, so nothing else will push the stream.
  if (streamOnchainEnabled() && isOnchainStreamId(id)) {
    if (remainderMicros <= 0n && p.claimableTranches <= 0) {
      // Nothing undistributed left on chain, fully released. No withdraw tx.
      return NextResponse.json({
        ok: true,
        state: "cancelled",
        refunded: true,
        refundUsd: 0,
      });
    }
    try {
      const { bytes } = await buildStreamCancelSponsored({
        senderAddress: row.sender_address,
        streamObjectId: id,
        settleAccrued: !wasPaused,
        claimableTranches: p.claimableTranches,
      });
      return NextResponse.json({
        ok: true,
        state: "cancelled",
        mode: "onchain",
        bytes,
        refundUsd: Math.max(0, refundUsd),
        /** What the composed claim pushes to the recipient before the refund. */
        settledUsd: wasPaused ? 0 : p.claimableUsd,
      });
    } catch (err) {
      const msg = (err as Error).message ?? "cancel build failed";
      console.warn(`[streams/cancel] on-chain cancel build failed stream=${id}: ${msg}`);
      // Row is cancelled regardless; surface a non-fatal note so iOS can retry
      // the withdraw without re-cancelling. Funds stay safe in the Stream
      // object (the sender can always re-issue cancel_and_withdraw).
      return NextResponse.json({
        ok: true,
        state: "cancelled",
        mode: "onchain",
        refunded: false,
        refundUsd: Math.max(0, refundUsd),
        detail: msg,
      });
    }
  }

  // Non-on-chain streams no longer exist (escrow + scheduler rail retired). The
  // row is already flipped to cancelled above; return a clean terminal state.
  return NextResponse.json({
    ok: true,
    state: "cancelled",
    refunded: remainderMicros <= 0n,
    refundUsd: Math.max(0, refundUsd),
  });
}
