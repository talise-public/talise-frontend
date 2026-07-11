import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { moneyRulesEnabled, resumeRule } from "@/lib/money-rules";

export const runtime = "nodejs";

/**
 * POST /api/rules/[id]/resume — re-arm a paused rule. next_due_at is recomputed
 * from now so a long-paused rule doesn't fire a backlog at once. Ownership-gated.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ruleId = (id ?? "").trim();
  if (!ruleId) return NextResponse.json({ error: "missing rule id" }, { status: 400 });

  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  if (!moneyRulesEnabled()) return NextResponse.json({ error: "Automated rules aren't available yet." }, { status: 503 });

  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  const rule = await resumeRule(ruleId, userId);
  if (!rule) return NextResponse.json({ error: "rule not found" }, { status: 404 });
  return NextResponse.json({ rule });
}
