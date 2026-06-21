import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { requireAppAttestStructural } from "@/lib/app-attest";
import { getCheque, voidCheque } from "@/lib/cheques";

export const runtime = "nodejs";

/**
 * POST /api/cheques/:id/void
 *
 * Creator reclaim of an unclaimed (funded) cheque: escrow→creator, funded→voided.
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
  const cq = await getCheque(id);
  if (!cq) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (cq.creatorUserId !== userId) return NextResponse.json({ error: "not_owner" }, { status: 403 });

  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  const r = await voidCheque({
    chequeId: id,
    creatorUserId: userId,
    creatorAddress: user.sui_address,
  });
  if (!r.ok) return NextResponse.json({ error: r.reason ?? "void_failed" }, { status: 409 });
  return NextResponse.json({ ok: true, digest: r.digest, status: "voided" });
}
