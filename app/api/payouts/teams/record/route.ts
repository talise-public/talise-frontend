import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import { upsertPayoutTeam } from "@/lib/payout-teams";
import {
  payrollOnchainEnabled,
  parseCreatedTeamObjectId,
} from "@/lib/payroll-onchain";

export const runtime = "nodejs";

/**
 * POST /api/payouts/teams/record
 *
 * Finalize an on-chain team save after the client has signed + executed the
 * sponsor-ready bytes returned by POST /api/payouts/teams. Body:
 *   `{ digest, name, members, chainObjectId? }`
 *
 *   • create (no chainObjectId) → parse the new Team object id from `digest`.
 *   • edit   (chainObjectId set) → reuse it (the object id is stable).
 *
 * Then upsert the DB row, the operational store the pay path re-resolves. We
 * upsert even if the object-id parse lags (chainObjectId stays null and is
 * back-filled on the next edit) so a confirmed roster is never lost.
 */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;

  const rl = await rateLimitAsync({
    key: `payouts-teams-record:user:${userId}`,
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

  if (!payrollOnchainEnabled()) {
    return NextResponse.json({ error: "on-chain teams disabled" }, { status: 400 });
  }

  let body: {
    digest?: string;
    name?: string;
    members?: unknown;
    chainObjectId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const digest = (body.digest ?? "").trim();
  const name = (body.name ?? "").trim();
  if (!digest) {
    return NextResponse.json({ error: "missing digest" }, { status: 400 });
  }
  if (!name) {
    return NextResponse.json({ error: "a team needs a name" }, { status: 400 });
  }

  // Edit reuses the stable object id; create parses it out of the confirmed tx.
  let chainObjectId = (body.chainObjectId ?? "").trim() || null;
  if (!chainObjectId) {
    chainObjectId = await parseCreatedTeamObjectId(digest);
  }

  try {
    const team = await upsertPayoutTeam({
      userId,
      name,
      members: body.members as never,
      chainObjectId,
    });
    return NextResponse.json({ team });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? "couldn't save team" },
      { status: 400 }
    );
  }
}
