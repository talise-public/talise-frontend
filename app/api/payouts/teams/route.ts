import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import {
  payoutTeamsFor,
  upsertPayoutTeam,
  payoutTeamByName,
  sanitizeMembers,
} from "@/lib/payout-teams";
import {
  payrollOnchainEnabled,
  resolveRoster,
  buildTeamCreateSponsored,
  buildTeamEditSponsored,
} from "@/lib/payroll-onchain";

export const runtime = "nodejs";

/**
 * /api/payouts/teams
 *
 *   GET  → list the caller's saved payout teams (newest-touched first).
 *   POST → save a team by name: `{ name, members: [{recipient, amount?, label?}] }`.
 *
 * The POST response is one of two shapes:
 *   • `{ mode: "db", team }`      , on-chain disabled: plain DB upsert (legacy).
 *   • `{ mode: "onchain", bytes,  , on-chain enabled: sponsor-ready Move-call
 *        edit, chainObjectId?, name } bytes for the client to sign; the roster
 *                                     is then finalized in /api/payouts/teams/record.
 *
 * Auth + the private-beta guardrail mirror the sibling batch routes exactly.
 * Teams carry NO money and are NEVER trusted on the send path, recipients are
 * re-resolved + re-screened at /api/payouts/batch/prepare time.
 */

export async function GET(req: Request) {
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

  const teams = await payoutTeamsFor(userId);
  return NextResponse.json({ teams });
}

export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // Private-beta guardrail: account must be on the app allowlist.
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;

  const rl = await rateLimitAsync({
    key: `payouts-teams-save:user:${userId}`,
    limit: 60,
    windowSec: 3600,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }

  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: { name?: string; members?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "a team needs a name" }, { status: 400 });
  }

  // Legacy / on-chain-disabled path: plain DB upsert, unchanged.
  if (!payrollOnchainEnabled()) {
    try {
      const team = await upsertPayoutTeam({
        userId,
        name,
        members: body.members as never,
      });
      return NextResponse.json({ mode: "db", team });
    } catch (err) {
      return NextResponse.json(
        { error: (err as Error).message ?? "couldn't save team" },
        { status: 400 }
      );
    }
  }

  // On-chain path: resolve the roster, then hand back sponsor-ready bytes for
  // either create (new name) or set_roster (existing on-chain team). The DB row
  // is written only after the client signs, in /api/payouts/teams/record.
  try {
    const members = sanitizeMembers(body.members);
    const roster = await resolveRoster(members);

    const existing = await payoutTeamByName(userId, name);
    if (existing?.chainObjectId) {
      const { bytes } = await buildTeamEditSponsored({
        senderAddress: user.sui_address,
        teamObjectId: existing.chainObjectId,
        name,
        roster,
      });
      return NextResponse.json({
        mode: "onchain",
        edit: true,
        chainObjectId: existing.chainObjectId,
        name,
        bytes,
      });
    }

    const { bytes } = await buildTeamCreateSponsored({
      senderAddress: user.sui_address,
      name,
      roster,
    });
    return NextResponse.json({ mode: "onchain", edit: false, name, bytes });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? "couldn't prepare team" },
      { status: 400 }
    );
  }
}
