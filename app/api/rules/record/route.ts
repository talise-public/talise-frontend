import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { moneyRulesEnabled, recordCreatedRule, type TriggerType } from "@/lib/money-rules";

export const runtime = "nodejs";

const ADDRESS_RE = /^0x[a-f0-9]{64}$/i;

/**
 * POST /api/rules/record — activate a scheduled-payment rule after the user has
 * signed + executed the `standing_order::create` from POST /api/rules.
 *
 * Body: { digest, firstDueMs, name, trigger, intervalMinutes?, dayOfMonth?,
 *         toAddress, toHandle?, amountUsd }
 * Parses the new on-chain order id from `digest` and inserts the active rule.
 */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  if (!moneyRulesEnabled()) return NextResponse.json({ error: "Automations aren't available yet." }, { status: 503 });

  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  let body: {
    digest?: string; firstDueMs?: number; name?: string; trigger?: string;
    intervalMinutes?: number; dayOfMonth?: number;
    toAddress?: string; toHandle?: string; amountUsd?: number;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const digest = (body.digest ?? "").trim();
  const firstDueMs = Number(body.firstDueMs);
  const toAddress = (body.toAddress ?? "").trim().toLowerCase();
  const amountUsd = Number(body.amountUsd);
  if (!digest) return NextResponse.json({ error: "missing digest" }, { status: 400 });
  if (!Number.isFinite(firstDueMs) || firstDueMs <= 0) return NextResponse.json({ error: "missing firstDueMs" }, { status: 400 });
  if (!ADDRESS_RE.test(toAddress)) return NextResponse.json({ error: "bad recipient" }, { status: 400 });
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return NextResponse.json({ error: "bad amount" }, { status: 400 });

  try {
    const rule = await recordCreatedRule(
      {
        userId, ownerAddress: user.sui_address, name: (body.name ?? "").trim(),
        triggerType: ((body.trigger ?? "schedule").trim() as TriggerType), actionType: "send",
        intervalMinutes: body.intervalMinutes == null ? null : Number(body.intervalMinutes),
        dayOfMonth: body.dayOfMonth == null ? null : Number(body.dayOfMonth),
        send: { toAddress, toHandle: body.toHandle ?? null, amountMicros: BigInt(Math.round(amountUsd * 1e6)) },
      },
      digest,
      firstDueMs
    );
    return NextResponse.json({ rule });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message ?? "Couldn't record the rule." }, { status: 400 });
  }
}
