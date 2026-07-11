import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { moneyRulesEnabled, deleteRule } from "@/lib/money-rules";

export const runtime = "nodejs";

/**
 * DELETE /api/rules/[id] — soft-delete a rule (the cron only reads
 * state='active' AND deleted_at IS NULL). Idempotent + ownership-gated.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const ok = await deleteRule(ruleId, userId);
  if (!ok) return NextResponse.json({ error: "rule not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
