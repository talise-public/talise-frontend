import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { streamById, projectStream } from "@/lib/streams";

export const runtime = "nodejs";

/**
 * GET /api/streams/[id]
 *
 * Status for one stream with computed progress. Authorized to the SENDER or
 * the RECIPIENT only (a stream's parties — not arbitrary callers).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const { id } = await params;
  const row = await streamById(id);
  if (!row) {
    return NextResponse.json({ error: "stream not found" }, { status: 404 });
  }

  const isSender = row.sender_user_id === userId;
  const isRecipient =
    row.recipient_address.toLowerCase() === user.sui_address.toLowerCase();
  if (!isSender && !isRecipient) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({
    stream: { ...projectStream(row), role: isSender ? "sender" : "recipient", isSender, isRecipient },
  });
}
