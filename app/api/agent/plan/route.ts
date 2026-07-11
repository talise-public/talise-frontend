import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import type { ChatStep } from "@/lib/chat/intent";
import { planIntent } from "@/lib/agent/plan";

export const runtime = "nodejs";

/**
 * POST /api/agent/plan — the Talise Agent's safety brain.
 *
 * Body: `{ steps: ChatStep[] }` — the intent the agent proposed (parsed client-side
 * from the `---INTENT---` block). Returns a VALIDATED, priced preview (recipients
 * resolved + screened, send total cap-checked) the client renders as a confirm card.
 *
 * This endpoint moves NO money — it neither prepares, signs, nor broadcasts. Only
 * after the user slides to confirm does the client call the real prepare + sign
 * endpoints per step. Same guardrails (auth, app-access, rate-limit) as the money
 * routes so the agent can't be used to probe limits at scale.
 */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;

  const rl = await rateLimitAsync({ key: `agent-plan:user:${userId}`, limit: 60, windowSec: 3600 });
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } });
  }

  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  let body: { steps?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const steps = Array.isArray(body.steps) ? (body.steps as ChatStep[]) : null;
  if (!steps || steps.length === 0) {
    return NextResponse.json({ error: "no steps" }, { status: 400 });
  }
  if (steps.length > 20) {
    return NextResponse.json({ error: "too many steps" }, { status: 400 });
  }

  try {
    const plan = await planIntent(user, steps);
    return NextResponse.json(plan);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message ?? "couldn't plan" }, { status: 500 });
  }
}
