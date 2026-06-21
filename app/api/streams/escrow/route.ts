import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { streamEscrowAddress, streamEscrowEnabled } from "@/lib/streams";

export const runtime = "nodejs";

/**
 * GET /api/streams/escrow
 *
 * Returns the Talise stream-escrow address so the client can fund a stream by
 * sending the full amount to it over the normal send rail (gasless/sponsored),
 * then call /api/streams/record with the resulting digest + schedule. Keeps
 * iOS funding on the proven signAndSubmitSend path instead of signing raw
 * prepare bytes. 503 when the escrow key isn't provisioned.
 */
export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  if (!streamEscrowEnabled()) {
    return NextResponse.json({ error: "streaming_disabled" }, { status: 503 });
  }
  return NextResponse.json({ escrowAddress: streamEscrowAddress() });
}
