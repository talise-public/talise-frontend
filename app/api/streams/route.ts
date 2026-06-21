import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { streamsForUser, projectStream } from "@/lib/streams";

export const runtime = "nodejs";

/**
 * GET /api/streams
 *
 * List the caller's streams — as SENDER and as RECIPIENT — with computed
 * progress (releasedUsd / remainingUsd / tranchesDone / nextTrancheAt /
 * state). Reads the DB row (fast); the per-tranche ledger + escrow are the
 * source of truth, the row is the cache.
 */
export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const rows = await streamsForUser(userId, user.sui_address);
  const myAddr = user.sui_address.toLowerCase();
  const streams = rows.map((r) => {
    const p = projectStream(r);
    return {
      ...p,
      role: r.sender_user_id === userId ? "sender" : "recipient",
      isSender: r.sender_user_id === userId,
      isRecipient: r.recipient_address.toLowerCase() === myAddr,
    };
  });

  return NextResponse.json({ streams });
}
