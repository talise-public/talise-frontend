import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { requireAppAttestStructural } from "@/lib/app-attest";
import { rateLimitAsync } from "@/lib/rate-limit";
import {
  streamById,
  setStreamState,
  streamOnchainEnabled,
  isOnchainStreamId,
  buildStreamCancelSponsored,
} from "@/lib/streams";

export const runtime = "nodejs";

/**
 * POST /api/streams/[id]/cancel
 *
 * Sender-only, terminal. Marks the stream `cancelled` (stops all releases) and
 * returns the undistributed remainder to the sender. Already-released tranches
 * stay with the recipient. Idempotent: cancelling an already-cancelled stream
 * no-ops.
 *
 * Streaming is ON-CHAIN only: the refund is a SENDER-signed
 * `stream::cancel_and_withdraw` — only the user's zkLogin can sign it. The
 * server flips the row to cancelled and returns Onara-SPONSORED cancel bytes
 * with `mode:'onchain'` for iOS to sign and POST to /api/zk/sponsor-execute;
 * that tx withdraws the remainder Coin<USDSUI> back to the sender.
 *
 * Order: flip state FIRST, then return cancel bytes.
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

  // Stop the scheduler from racing a release against the refund.
  await setStreamState(id, "cancelled");

  const remainderMicros = BigInt(row.total_micros) - BigInt(row.released_micros);
  const refundUsd = Number(remainderMicros) / 1e6;

  // ── ON-CHAIN path: only the sender's zkLogin can sign cancel_and_withdraw.
  // Return Onara-SPONSORED cancel bytes for iOS to sign + execute. The row is
  // already flipped to cancelled, so the scheduler won't release further.
  if (streamOnchainEnabled() && isOnchainStreamId(id)) {
    if (remainderMicros <= 0n) {
      // Nothing undistributed left on chain — fully released. No withdraw tx.
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
      });
      return NextResponse.json({
        ok: true,
        state: "cancelled",
        mode: "onchain",
        bytes,
        refundUsd: Math.max(0, refundUsd),
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
