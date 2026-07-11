import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { deletePayoutTeam } from "@/lib/payout-teams";

export const runtime = "nodejs";

/**
 * POST /api/payouts/teams/[id]/record
 *
 * Finalize an on-chain team DELETE: after the client signs + executes the
 * sponsor-ready `payroll::delete` bytes returned by DELETE /api/payouts/teams/[id],
 * this removes the DB index row. Body: `{ digest }` (recorded for audit only —
 * the on-chain delete already happened; removing the row is idempotent and
 * ownership-gated by the WHERE clause).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const teamId = (id ?? "").trim();
  if (!teamId) {
    return NextResponse.json({ error: "missing team id" }, { status: 400 });
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;

  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const removed = await deletePayoutTeam(teamId, userId);
  return NextResponse.json({ ok: true, removed });
}
