import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { requireAppAttestStructural } from "@/lib/app-attest";
import { getCheque, markFunded } from "@/lib/cheques";

export const runtime = "nodejs";

/**
 * POST /api/cheques/:id/confirm-funded  { digest }
 *
 * Called by the creator after their on-chain deposit to the escrow lands.
 * Verifies the digest credited the escrow with the cheque amount and flips
 * draft→funded (single-use via the partial-unique fund_digest index).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const attestBlock = requireAppAttestStructural(req);
  if (attestBlock) return attestBlock;

  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { id } = await params;
  let body: { digest?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!body.digest) return NextResponse.json({ error: "missing digest" }, { status: 400 });

  const cq = await getCheque(id);
  if (!cq) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (cq.creatorUserId !== userId) {
    return NextResponse.json({ error: "not_owner" }, { status: 403 });
  }

  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  // markFunded picks the rail itself: on-chain (parse the created Cheque
  // object id from `digest`, the sponsored cheque::create tx) or escrow
  // (verify the deposit credited the escrow address). Either way it flips
  // draft→funded atomically.
  const r = await markFunded({ chequeId: id, digest: body.digest, creatorAddress: user.sui_address });
  if (!r.ok) {
    return NextResponse.json({ error: r.reason ?? "confirm_failed" }, { status: 409 });
  }
  return NextResponse.json({ ok: true, status: "funded", chequeObjectId: r.chequeObjectId });
}
