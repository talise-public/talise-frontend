import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { rateLimitAsync } from "@/lib/rate-limit";
import {
  archiveGoal,
  depositToGoal,
  withdrawFromGoal,
  getGoal,
  updateGoal,
  GOAL_DEPOSIT_MAX_USD,
  type SavingsGoal,
} from "@/lib/rewards/goals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toWire(g: SavingsGoal) {
  return {
    id: String(g.id),
    name: g.name,
    targetUsd: g.targetUsd,
    currentUsd: g.currentUsd,
    deadlineMs: g.deadlineMs,
    color: g.color,
    createdAtMs: g.createdAt,
    archived: g.archived,
    completed: g.completed,
    vaultObjectId: g.vaultObjectId,
    yieldOn: g.yieldOn,
  };
}

type Ctx = { params: Promise<{ id: string }> };

async function resolveId(ctx: Ctx): Promise<number | null> {
  const { id } = await ctx.params;
  const n = Number(id);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

async function auth(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return null;
  const user = await userById(userId);
  if (!user) return null;
  return userId;
}

/**
 * GET /api/rewards/goals/[id] — fetch a single goal (handy for the
 * edit sheet pre-populate path).
 */
export async function GET(req: Request, ctx: Ctx) {
  const userId = await auth(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const id = await resolveId(ctx);
  if (!id) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const g = await getGoal(userId, id);
  if (!g) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ goal: toWire(g) });
}

/**
 * PATCH /api/rewards/goals/[id] — update name/target/deadline/color, or
 * archive (`{ archive: true }`). Returns the post-update goal.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  const userId = await auth(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const id = await resolveId(ctx);
  if (!id) return NextResponse.json({ error: "bad id" }, { status: 400 });
  let body: {
    name?: unknown;
    targetUsd?: unknown;
    deadlineMs?: unknown;
    color?: unknown;
    archive?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    if (body.archive === true) {
      const g = await archiveGoal(userId, id);
      if (!g) return NextResponse.json({ error: "not found" }, { status: 404 });
      return NextResponse.json({ goal: toWire(g) });
    }
    const patch: Parameters<typeof updateGoal>[2] = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (body.targetUsd !== undefined) patch.targetUsd = Number(body.targetUsd);
    if (body.deadlineMs !== undefined) {
      patch.deadlineMs =
        body.deadlineMs === null ? null : Number(body.deadlineMs);
    }
    if (body.color !== undefined) {
      patch.color = body.color === null ? null : String(body.color);
    }
    const g = await updateGoal(userId, id, patch);
    if (!g) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ goal: toWire(g) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * POST /api/rewards/goals/[id] — tracking deposit OR withdrawal.
 * Body: { amountUsd: number, action?: "deposit" | "withdraw" }.
 *  - deposit (default): bumps `current_usd`, writes a `goal_deposit` event.
 *  - withdraw: reduces `current_usd` back toward 0 (the dollars were always
 *    liquid in the user's own yield-earning balance), writes `goal_withdraw`.
 * Returns the post-action goal.
 */
export async function POST(req: Request, ctx: Ctx) {
  const userId = await auth(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  // Private-beta guardrail: only allowlisted accounts may touch the ledger.
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  const id = await resolveId(ctx);
  if (!id) return NextResponse.json({ error: "bad id" }, { status: 400 });
  let body: { amountUsd?: unknown; action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const amountUsd = Number(body.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return NextResponse.json(
      { error: "amountUsd must be positive" },
      { status: 400 }
    );
  }
  const isWithdraw = body.action === "withdraw";

  // Throttle per account+action (deposits mint nothing now, but both are
  // self-report writes — keep the anti-abuse cap).
  const rl = await rateLimitAsync({
    key: `goal-${isWithdraw ? "withdraw" : "deposit"}:user:${userId}`,
    limit: 12,
    windowSec: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } }
    );
  }

  try {
    if (isWithdraw) {
      const { goal, withdrawnUsd } = await withdrawFromGoal({
        userId,
        goalId: id,
        amountUsd,
      });
      return NextResponse.json({ goal: toWire(goal), withdrawnUsd });
    }
    // Reject absurd amounts outright (depositToGoal also clamps as a backstop).
    if (amountUsd > GOAL_DEPOSIT_MAX_USD) {
      return NextResponse.json(
        { error: `amountUsd exceeds the $${GOAL_DEPOSIT_MAX_USD.toLocaleString()} per-deposit limit` },
        { status: 400 }
      );
    }
    const { goal, points } = await depositToGoal({ userId, goalId: id, amountUsd });
    return NextResponse.json({ goal: toWire(goal), pointsAwarded: points });
  } catch (err) {
    const msg = (err as Error).message;
    const status = msg === "goal not found" ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
