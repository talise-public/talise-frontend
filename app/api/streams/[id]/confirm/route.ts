import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { requireAppAttestStructural } from "@/lib/app-attest";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import {
  streamById,
  isOnchainStreamId,
  recordStreamTx,
  projectStream,
} from "@/lib/streams";

export const runtime = "nodejs";

/**
 * POST /api/streams/[id]/confirm   body: `{ digest }`
 *
 * STEP 2 for EVERY stream action — claim, pause, resume, cancel. The client
 * signs the sponsor-ready bytes, executes them, then hands the digest here and
 * the mirror re-reads the contract.
 *
 * Deliberately does NOT trust the digest for any figure. `recordStreamTx` reads
 * the on-chain `Stream` object and writes only what the contract's own
 * `tranches_done` / `released_amount` / `paused` / `cancelled` fields say, so a
 * forged or replayed digest cannot move a single micro. The digest's only job
 * is to tell us a tx just landed, which is worth a couple of retries because
 * fullnode reads lag execution by a beat.
 *
 * Idempotent by construction: re-confirming the same digest re-reads the same
 * object and writes the same values, and the release cursors only ever advance.
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
    key: `streams-confirm:user:${userId}`,
    limit: 120,
    windowSec: 3600,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }

  const { id } = await params;

  let body: { digest?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const digest = (body.digest ?? "").trim();

  const row = await streamById(id);
  if (!row) {
    return NextResponse.json({ error: "stream not found" }, { status: 404 });
  }

  // A stream's parties only. The sync itself is harmless (it just mirrors public
  // chain state), this gate is about not leaking one user's stream to another.
  const user = await userById(userId);
  const callerAddr = (user?.sui_address ?? "").toLowerCase();
  const isSender = row.sender_user_id === userId;
  const isRecipient = callerAddr === row.recipient_address.toLowerCase();
  if (!isSender && !isRecipient) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (!isOnchainStreamId(id)) {
    return NextResponse.json({ ok: true, stream: projectStream(row) });
  }

  const fresh = (await recordStreamTx(id, digest)) ?? row;
  return NextResponse.json({
    ok: true,
    stream: {
      ...projectStream(fresh),
      role: isSender ? "sender" : "recipient",
      isSender,
      isRecipient,
    },
  });
}
