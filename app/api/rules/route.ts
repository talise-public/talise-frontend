import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import { resolveRecipient } from "@/lib/suins";
import { screenTransfer } from "@/lib/screening";
import {
  moneyRulesEnabled,
  prepareCreateRule,
  listRules,
  type TriggerType,
} from "@/lib/money-rules";

export const runtime = "nodejs";

const ADDRESS_RE = /^0x[a-f0-9]{64}$/i;
const MAX_USD = 10_000;

/** GET /api/rules — the caller's money rules (newest first). `enabled` is false
 *  when the automations engine isn't configured (UI shows "coming soon"). */
export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;

  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  if (!moneyRulesEnabled()) return NextResponse.json({ rules: [], enabled: false });
  const rules = await listRules(userId);
  return NextResponse.json({ rules, enabled: true });
}

/**
 * POST /api/rules — PREPARE a scheduled-payment rule (non-custodial).
 *
 * Body: { name, trigger:'schedule', action:'send', intervalMinutes?|dayOfMonth?,
 *         toRecipient, amountUsd, prefundUsd? }
 *
 * Resolves + screens the recipient, then returns the Onara-sponsored
 * `standing_order::create` bytes the user signs to fund the rule's on-chain pot
 * (`prefundUsd`, default = one payment). After signing, the client posts the
 * digest + echoed fields to /api/rules/record to activate it. Moves no money here.
 */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;

  if (!moneyRulesEnabled()) {
    return NextResponse.json(
      { error: "Automations aren't available yet.", code: "MONEY_RULES_DISABLED" },
      { status: 503 }
    );
  }

  const rl = await rateLimitAsync({ key: `money-rule-create:user:${userId}`, limit: 20, windowSec: 3600 });
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } });
  }

  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  let body: {
    name?: string; trigger?: string; action?: string;
    intervalMinutes?: number; dayOfMonth?: number;
    toRecipient?: string; amountUsd?: number; prefundUsd?: number;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const triggerType = (body.trigger ?? "schedule").trim() as TriggerType;
  const amountUsd = Number(body.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > MAX_USD) {
    return NextResponse.json({ error: "Enter a valid payout amount." }, { status: 400 });
  }
  const prefundUsd = Number(body.prefundUsd);
  const fundUsd = Number.isFinite(prefundUsd) && prefundUsd >= amountUsd ? prefundUsd : amountUsd;
  if (fundUsd > MAX_USD) return NextResponse.json({ error: "That funding amount is too large." }, { status: 400 });

  const rawTo = (body.toRecipient ?? "").trim();
  if (!rawTo) return NextResponse.json({ error: "Choose who this rule pays." }, { status: 400 });
  let resolved;
  try { resolved = await resolveRecipient(rawTo); } catch { resolved = null; }
  if (!resolved || !ADDRESS_RE.test(resolved.address)) {
    return NextResponse.json({ error: `Couldn't resolve "${rawTo}".`, code: "RESOLVE_FAILED" }, { status: 400 });
  }
  const toAddress = resolved.address.toLowerCase();
  if (toAddress === user.sui_address.toLowerCase()) {
    return NextResponse.json({ error: "A rule can't pay your own wallet.", code: "SELF_RECIPIENT" }, { status: 400 });
  }

  const screen = await screenTransfer({
    senderAddr: user.sui_address, recipientAddr: toAddress,
    senderName: user.business_name ?? user.name, recipientName: null,
  });
  if (!screen.allow) {
    return NextResponse.json({ error: "That recipient was blocked by a compliance screen.", code: "SCREENING_BLOCK" }, { status: 403 });
  }

  const name = (body.name ?? "").trim();
  const amountMicros = BigInt(Math.round(amountUsd * 1e6));
  const prefundMicros = BigInt(Math.round(fundUsd * 1e6));

  try {
    const { bytes, firstDueMs } = await prepareCreateRule(
      {
        userId, ownerAddress: user.sui_address, name, triggerType, actionType: "send",
        intervalMinutes: body.intervalMinutes == null ? null : Number(body.intervalMinutes),
        dayOfMonth: body.dayOfMonth == null ? null : Number(body.dayOfMonth),
        send: { toAddress, toHandle: resolved.displayName ?? null, amountMicros },
      },
      prefundMicros
    );
    // Echo back exactly what to /record after signing (the contract is the
    // source of truth for recipient+amount; this is the DB/ledger mirror).
    return NextResponse.json({
      mode: "onchain",
      bytes,
      firstDueMs,
      record: {
        name, trigger: triggerType,
        intervalMinutes: body.intervalMinutes ?? null,
        dayOfMonth: body.dayOfMonth ?? null,
        toAddress, toHandle: resolved.displayName ?? null, amountUsd,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message ?? "Couldn't prepare the rule." }, { status: 400 });
  }
}
