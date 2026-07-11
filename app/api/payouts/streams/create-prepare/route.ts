import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import { payoutTeamById } from "@/lib/payout-teams";
import { resolveRecipient } from "@/lib/suins";
import { screenTransfer } from "@/lib/screening";
import {
  teamStreamsEnabled,
  teamStreamEscrowAddress,
  createDraftTeamStream,
  type TeamStreamMember,
} from "@/lib/team-streams";

export const runtime = "nodejs";

const ADDRESS_RE = /^0x[a-f0-9]{64}$/i;
const MAX_USD = 10_000;

/**
 * POST /api/payouts/streams/create-prepare
 *
 * Draft a team stream: fund `totalUsd` once, then equal shares stream to every
 * member of team `teamId` over `numTranches` payouts, one every `intervalMinutes`.
 * Resolves + screens every member, drafts the stream, and returns the escrow
 * address to fund (the client sends `totalUsd` USDsui there over the normal
 * gasless rail, then calls /record with the funding digest).
 *
 * Body: { teamId, totalUsd, numTranches, intervalMinutes }
 */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;

  if (!teamStreamsEnabled()) {
    return NextResponse.json(
      { error: "Team streaming isn't available yet.", code: "TEAM_STREAMS_DISABLED" },
      { status: 503 }
    );
  }

  const rl = await rateLimitAsync({ key: `team-stream-create:user:${userId}`, limit: 20, windowSec: 3600 });
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } });
  }

  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  let body: { teamId?: string; totalUsd?: number; numTranches?: number; intervalMinutes?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const totalUsd = Number(body.totalUsd);
  const numTranches = Number(body.numTranches);
  const intervalMinutes = Number(body.intervalMinutes);
  if (!Number.isFinite(totalUsd) || totalUsd <= 0 || totalUsd > MAX_USD) {
    return NextResponse.json({ error: "Enter a valid amount to stream." }, { status: 400 });
  }
  if (!Number.isInteger(numTranches) || numTranches < 1) {
    return NextResponse.json({ error: "Choose how many payouts to split this into." }, { status: 400 });
  }
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) {
    return NextResponse.json({ error: "Choose how often payouts happen." }, { status: 400 });
  }

  // Load the team (must be the caller's).
  const team = await payoutTeamById((body.teamId ?? "").trim(), userId);
  if (!team) return NextResponse.json({ error: "Team not found.", code: "TEAM_NOT_FOUND" }, { status: 404 });
  if (team.members.length === 0) {
    return NextResponse.json({ error: "This team has no members.", code: "TEAM_EMPTY" }, { status: 400 });
  }

  // Resolve + screen every member (never trust stored addresses on the money path).
  const selfAddr = user.sui_address.toLowerCase();
  const seen = new Set<string>();
  const members: TeamStreamMember[] = [];
  for (let i = 0; i < team.members.length; i++) {
    const input = team.members[i].recipient;
    let resolved;
    try { resolved = await resolveRecipient(input); } catch { resolved = null; }
    if (!resolved || !ADDRESS_RE.test(resolved.address)) {
      return NextResponse.json({ error: `Couldn't resolve "${input}".`, code: "RESOLVE_FAILED" }, { status: 400 });
    }
    const addr = resolved.address.toLowerCase();
    if (addr === selfAddr) {
      return NextResponse.json({ error: `"${input}" is your own wallet.`, code: "SELF_MEMBER" }, { status: 400 });
    }
    if (seen.has(addr)) continue; // de-dupe silently
    seen.add(addr);
    members.push({ address: addr, handle: resolved.displayName ?? null });
  }

  const screens = await Promise.all(
    members.map((m) => screenTransfer({ senderAddr: user.sui_address, recipientAddr: m.address, senderName: user.business_name ?? user.name, recipientName: null }))
  );
  if (screens.some((s) => !s.allow)) {
    return NextResponse.json({ error: "A member was blocked by a compliance screen.", code: "SCREENING_BLOCK" }, { status: 403 });
  }

  try {
    const totalMicros = BigInt(Math.round(totalUsd * 1e6));
    const stream = await createDraftTeamStream({
      senderUserId: userId,
      senderAddress: user.sui_address,
      teamId: team.id,
      teamName: team.name,
      members,
      totalMicros,
      numTranches,
      intervalMs: intervalMinutes * 60_000,
    });
    return NextResponse.json({
      streamId: stream.id,
      escrowAddress: teamStreamEscrowAddress(),
      totalUsd: stream.totalUsd,
      perMemberUsd: stream.perMemberUsd,
      trancheUsd: stream.trancheUsd,
      numTranches: stream.numTranches,
      memberCount: stream.memberCount,
      intervalMs: stream.intervalMs,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message ?? "Couldn't prepare the stream." }, { status: 400 });
  }
}
