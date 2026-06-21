import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import {
  createGoal,
  listGoals,
  type SavingsGoal,
} from "@/lib/rewards/goals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Wire shape used by iOS — see APIModels.swift `SavingsGoal`. */
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

/**
 * GET /api/rewards/goals — list the authenticated user's active savings
 * goals (archived excluded). Returns { goals: [...] }.
 */
export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }
  try {
    const goals = await listGoals(userId);
    return NextResponse.json({ goals: goals.map(toWire) });
  } catch (err) {
    console.warn(
      `[rewards/goals] user=${userId} failed: ${(err as Error).message}`
    );
    return NextResponse.json(
      { error: "could not process goals request" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/rewards/goals — create a new goal.
 * Body: { name: string, targetUsd: number, deadlineMs?: number|null, color?: string }
 */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }
  let body: {
    name?: unknown;
    targetUsd?: unknown;
    deadlineMs?: unknown;
    color?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name : "";
  const targetUsd = Number(body.targetUsd);
  const deadlineMs =
    body.deadlineMs === null ||
    body.deadlineMs === undefined ||
    body.deadlineMs === ""
      ? null
      : Number(body.deadlineMs);
  const color = typeof body.color === "string" ? body.color : null;

  if (!name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (!Number.isFinite(targetUsd) || targetUsd <= 0) {
    return NextResponse.json(
      { error: "targetUsd must be positive" },
      { status: 400 }
    );
  }
  try {
    const goal = await createGoal({
      userId,
      name,
      targetUsd,
      deadlineMs: deadlineMs !== null && Number.isFinite(deadlineMs) ? deadlineMs : null,
      color,
    });
    return NextResponse.json({ goal: toWire(goal) });
  } catch (err) {
    console.warn(
      `[rewards/goals] user=${userId} failed: ${(err as Error).message}`
    );
    return NextResponse.json(
      { error: "could not process goals request" },
      { status: 500 }
    );
  }
}
