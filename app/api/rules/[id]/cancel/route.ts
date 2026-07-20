import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { moneyRulesEnabled, prepareCancelRule } from "@/lib/money-rules";

export const runtime = "nodejs";

/**
 * POST /api/rules/[id]/cancel, return the owner-signed `standing_order::cancel`
 * bytes (stops the rule + refunds the entire remaining pot to the owner). The
 * client signs these, then DELETEs /api/rules/[id] to clear the row. Returns 409
 * if the rule has no on-chain order (nothing to refund, just DELETE it).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ruleId = (id ?? "").trim();
  if (!ruleId) return NextResponse.json({ error: "missing rule id" }, { status: 400 });

  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  if (!moneyRulesEnabled()) return NextResponse.json({ error: "Automations aren't available yet." }, { status: 503 });

  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  try {
    const prepared = await prepareCancelRule(ruleId, userId);
    if (!prepared) {
      return NextResponse.json({ error: "no on-chain order for this rule", code: "NO_ORDER" }, { status: 409 });
    }
    return NextResponse.json({ mode: "onchain", bytes: prepared.bytes });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message ?? "couldn't prepare cancel" }, { status: 400 });
  }
}
