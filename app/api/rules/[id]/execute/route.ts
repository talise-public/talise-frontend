import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import { moneyRulesEnabled, prepareExecuteRule } from "@/lib/money-rules";

export const runtime = "nodejs";

/**
 * POST /api/rules/[id]/execute, return the Onara-sponsored, PERMISSIONLESS
 * `standing_order::execute_due` bytes for a due rule the caller owns. The client
 * signs these (owner is the sender) and posts to /api/zk/sponsor-execute, then
 * calls /api/rules/[id]/executed with the digest. This is the "fire due rules on
 * app-open" trigger, there is no cron. The contract gates the actual release on
 * the Clock + schedule, so signing an not-yet-due rule simply aborts ENotDue.
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

  const rl = await rateLimitAsync({ key: `rule-execute:user:${userId}`, limit: 120, windowSec: 3600 });
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } });
  }

  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  try {
    const prepared = await prepareExecuteRule(ruleId, userId);
    if (!prepared) {
      return NextResponse.json({ error: "rule has no on-chain order to trigger", code: "NO_ORDER" }, { status: 409 });
    }
    return NextResponse.json({ mode: "onchain", bytes: prepared.bytes });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message ?? "couldn't prepare the release" }, { status: 400 });
  }
}
