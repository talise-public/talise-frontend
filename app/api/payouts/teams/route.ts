import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import { payoutTeamsFor, upsertPayoutTeam } from "@/lib/payout-teams";

export const runtime = "nodejs";

/**
 * /api/payouts/teams
 *
 *   GET  → list the caller's saved payout teams (newest-touched first).
 *   POST → upsert a team by name: `{ name, members: [{recipient, amount?, label?}] }`.
 *
 * Auth + the private-beta guardrail mirror the sibling batch routes exactly.
 * Teams carry NO money and are NEVER trusted on the send path — they're a UI
 * convenience; recipients are re-resolved + re-screened at prepare time.
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

  try {
    const team = await upsertPayoutTeam({
      userId,
      name,
      members: body.members as never,
    });
    return NextResponse.json({ team });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? "couldn't save team" },
      { status: 400 }
    );
  }
}
