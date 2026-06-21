import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { deletePayoutTeam } from "@/lib/payout-teams";

export const runtime = "nodejs";

/**
 * DELETE /api/payouts/teams/[id]
 *
 * Removes one of the caller's saved payout teams. Ownership is enforced in the
 * DELETE's WHERE clause (id + user_id), so a team that isn't the caller's is a
 * no-op (idempotent 200). Auth + the private-beta guardrail mirror the sibling
 * batch routes exactly.
 */

export async function DELETE(
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
  // Private-beta guardrail: account must be on the app allowlist.
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;

  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const removed = await deletePayoutTeam(teamId, userId);
  return NextResponse.json({ ok: true, removed });
}
