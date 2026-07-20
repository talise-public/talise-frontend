import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { requireAppAttestStructural } from "@/lib/app-attest";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import {
  streamById,
  streamOnchainEnabled,
  isOnchainStreamId,
  buildClaimAccruedSponsored,
} from "@/lib/streams";

export const runtime = "nodejs";

/**
 * POST /api/streams/[id]/claim
 *
 * The CRON-LESS, clock-based release path. Builds the Onara-SPONSORED
 * `stream::claim_accrued<USDSUI>` PTB and returns sponsor-ready bytes; the
 * caller (the recipient, in practice) signs with their zkLogin ephemeral key
 * and POSTs to /api/zk/sponsor-execute. The on-chain contract walks the
 * schedule against `Clock`, releases every tranche now due, and transfers it to
 * the stream's HARDWIRED recipient, so even though the call is permissionless,
 * funds can only ever go to the recipient, never the signer.
 *
 * No worker key, no scheduler. The recipient pulls their accrued balance
 * whenever they like; gas is sponsored so it's free.
 *
 * On-chain streams only, escrow streams are gone with the cron.
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
    key: `streams-claim:user:${userId}`,
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

  if (!streamOnchainEnabled() || !isOnchainStreamId(id)) {
    return NextResponse.json(
      { error: "claim is only available for on-chain streams", code: "NOT_ONCHAIN" },
      { status: 400 }
    );
  }

  const row = await streamById(id);
  if (!row) {
    return NextResponse.json({ error: "stream not found" }, { status: 404 });
  }
  if (row.state === "cancelled") {
    return NextResponse.json({ error: "stream is cancelled" }, { status: 409 });
  }

  // Authorize: the recipient (by address) or the sender may trigger the claim.
  // claim_accrued is permissionless on chain and only ever pays the hardwired
  // recipient, so this gate is purely to stop strangers spending Onara gas.
  const user = await userById(userId);
  const callerAddr = (user?.sui_address ?? "").toLowerCase();
  const isRecipient = callerAddr === row.recipient_address.toLowerCase();
  const isSender = row.sender_user_id === userId;
  if (!isRecipient && !isSender) {
    return NextResponse.json(
      { error: "only the stream's recipient or sender can claim" },
      { status: 403 }
    );
  }

  // Nothing left to release.
  if (Number(row.released_micros) >= Number(row.total_micros)) {
    return NextResponse.json({ ok: true, nothingToClaim: true });
  }

  try {
    const { bytes, sponsor } = await buildClaimAccruedSponsored({
      streamObjectId: id,
      // Sign as the recipient when they're the caller; otherwise the sender
      // signs (funds still route to the recipient on chain).
      signerAddress: isRecipient ? row.recipient_address : row.sender_address,
    });
    return NextResponse.json({ ok: true, mode: "onchain", bytes, sponsor });
  } catch (err) {
    const msg = (err as Error).message ?? "claim build failed";
    console.warn(`[streams/claim] build failed stream=${id}: ${msg}`);
    return NextResponse.json(
      { error: "Couldn't prepare the claim right now.", detail: msg },
      { status: 502 }
    );
  }
}
