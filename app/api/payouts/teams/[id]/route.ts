import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { deletePayoutTeam, payoutTeamById } from "@/lib/payout-teams";
import {
  payrollOnchainEnabled,
  buildTeamDeleteSponsored,
} from "@/lib/payroll-onchain";

export const runtime = "nodejs";

/**
 * DELETE /api/payouts/teams/[id]
 *
 * Removes one of the caller's saved payout teams. Two shapes:
 *   • `{ mode: "db", ok, removed }` — DB-only team (or on-chain disabled):
 *     deleted immediately. Ownership enforced in the WHERE clause (idempotent).
 *   • `{ mode: "onchain", bytes }`  — on-chain team: returns sponsor-ready
 *     `payroll::delete` bytes to sign; the DB row is removed afterwards by
 *     POST /api/payouts/teams/[id]/record. The DB row is NOT removed yet.
 *
 * Auth + the private-beta guardrail mirror the sibling batch routes exactly.
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

  // On-chain team → hand back sponsor-ready delete bytes; the DB row is removed
  // in the record step after the client signs. DB-only teams delete now.
  if (payrollOnchainEnabled()) {
    const team = await payoutTeamById(teamId, userId);
    if (team?.chainObjectId) {
      try {
        const { bytes } = await buildTeamDeleteSponsored({
          senderAddress: user.sui_address,
          teamObjectId: team.chainObjectId,
        });
        return NextResponse.json({ mode: "onchain", bytes });
      } catch (err) {
        return NextResponse.json(
          { error: (err as Error).message ?? "couldn't prepare delete" },
          { status: 400 }
        );
      }
    }
  }

  const removed = await deletePayoutTeam(teamId, userId);
  return NextResponse.json({ mode: "db", ok: true, removed });
}
