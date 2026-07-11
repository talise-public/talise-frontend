import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { moneyRulesEnabled, recordRuleExecuted } from "@/lib/money-rules";

export const runtime = "nodejs";

const DIGEST_RE = /^[1-9A-HJ-NP-Za-km-z]{40,60}$/;

/**
 * POST /api/rules/[id]/executed — record a confirmed on-chain `execute_due`
 * release for a rule the caller owns. Body: { digest }. Advances the rule's
 * `next_due_at` mirror by one interval and appends to the execution ledger.
 * Idempotent: the on-chain Clock already prevents a double PAY, and the ledger
 * is keyed on (rule_id, triggered_at).
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

  let body: { digest?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const digest = typeof body.digest === "string" ? body.digest.trim() : "";
  if (!DIGEST_RE.test(digest)) return NextResponse.json({ error: "a valid transaction digest is required" }, { status: 400 });

  try {
    const rule = await recordRuleExecuted(ruleId, userId, digest);
    if (!rule) return NextResponse.json({ error: "rule not found" }, { status: 404 });
    return NextResponse.json({ rule });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message ?? "couldn't record the release" }, { status: 400 });
  }
}
