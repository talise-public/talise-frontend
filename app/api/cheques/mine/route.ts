import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { listChequesForCreator } from "@/lib/cheques";

export const runtime = "nodejs";

/**
 * GET /api/cheques/mine
 *
 * The signed-in user's cheques (newest first) for the "My cheques" list —
 * each with a `reclaimable` flag (funded + unclaimed + not expired) so the
 * client can show a "Claim it back" action.
 */
export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const cheques = await listChequesForCreator(userId);
  return NextResponse.json({ cheques });
}
