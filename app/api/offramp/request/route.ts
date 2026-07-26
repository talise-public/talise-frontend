import { NextResponse } from "next/server";
import { db, ensureSchema, userById } from "@/lib/db";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { rateLimitAsync } from "@/lib/rate-limit";
import { resolveLinqBank } from "@/lib/linq-banks";
import { getUsdsuiBalance } from "@/lib/sui";
import { FX } from "@/lib/fx";
import { cashoutFeatureOpen, CASHOUT_CLOSED_MESSAGE } from "@/lib/linq";
import { checkDailyOfframpCapAllRails } from "@/lib/offramp/caps";
import { recordAttempt } from "@/lib/offramp/store";
import { trackCashoutStarted } from "@/lib/analytics/emit";

export const runtime = "nodejs";

/**
 * Per-request ceiling for a concierge (human-fulfilled) payout. Deliberately
 * modest: this path has no provider guardrails at all, a human reads the row and
 * sends naira, so the blast radius of a bad request is whatever a person will
 * action without questioning it.
 */
const CONCIERGE_MAX_USD = 500;

/**
 * POST /api/offramp/request, CONCIERGE cash-out (closed-alpha off-ramp).
 *
 * The automated Linq off-ramp (quote → create → send → poll) is the primary
 * path; this concierge route is the manual fallback for the web closed alpha.
 * We capture a payout *request* here, bank coordinates + amount, record it in
 * `linq_offramps` with `status='manual_requested'`, and ping the founder, who
 * fulfils the NGN payout by hand (collecting the USDsui out-of-band).
 *
 * Web session auth (no App Attest). Records a notional NGN at the reference
 * rate; the founder confirms the real rate at payout.
 */

const ACCT_RE = /^\d{6,12}$/;
const MAX_NAME = 120;

function reqId(): string {
  return (
    "mreq_" +
    Math.random().toString(36).slice(2, 8) +
    Math.random().toString(36).slice(2, 8)
  );
}

/** Best-effort founder ping: always logs loudly; emails if fully configured. */
async function notifyFounder(lines: Record<string, string | number>) {
  const summary = Object.entries(lines)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.error(`[CONCIERGE-PAYOUT] manual NGN payout requested, ${summary}`);

  const key = process.env.RESEND_API_KEY;
  const to = process.env.OFFRAMP_NOTIFY_EMAIL;
  const from = process.env.RESEND_FROM;
  if (!key || !to || !from) return; // log-only unless email is fully wired
  try {
    const html = `<h2>Cash-out request</h2><ul>${Object.entries(lines)
      .map(([k, v]) => `<li><b>${k}:</b> ${v}</li>`)
      .join("")}</ul>`;
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject: "Talise, cash-out request", html }),
    });
  } catch {
    /* email is a bonus, the log + the admin queue are the source of truth */
  }
}

export async function POST(req: Request) {
  // GATE BYPASS, FIXED. This route asks a human to send real naira, but it was
  // the ONLY off-ramp entry point with no `FEATURE_CASHOUT` check: with cash-out
  // deliberately shut off because the provider was failing without refunding,
  // users could still queue manual payouts here. Concierge is the manual
  // fallback for the automated rail, so it must respect the same product gate.
  if (!cashoutFeatureOpen()) {
    return NextResponse.json(
      { error: CASHOUT_CLOSED_MESSAGE, code: "CASHOUT_CLOSED" },
      { status: 503 }
    );
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const rl = await rateLimitAsync({
    key: `offramp-request:user:${userId}`,
    limit: 10,
    windowSec: 3600,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }

  let body: {
    amountUsdsui?: unknown;
    bankCode?: unknown;
    accountNumber?: unknown;
    accountName?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const amountUsdsui = Number(body.amountUsdsui);
  if (!Number.isFinite(amountUsdsui) || amountUsdsui <= 0) {
    return NextResponse.json({ error: "amount must be greater than zero" }, { status: 400 });
  }
  // The old ceiling here was $100,000 with NO daily cap check at all, on a route
  // whose fulfilment is a human sending money. A concierge request now has a
  // hard per-request ceiling AND consumes the same per-account daily allowance as
  // the automated rail. (Concierge rows are excluded from
  // `db.sumRecentOfframpUsd`, which is why the cap must be checked explicitly
  // here rather than relied on implicitly.)
  if (amountUsdsui > CONCIERGE_MAX_USD) {
    return NextResponse.json(
      {
        error: `Concierge cash-out is limited to $${CONCIERGE_MAX_USD} per request.`,
        code: "CONCIERGE_MAX",
      },
      { status: 400 }
    );
  }
  const cap = await checkDailyOfframpCapAllRails(userId, amountUsdsui);
  if (!cap.ok) {
    return NextResponse.json(
      {
        error: cap.error,
        code: cap.code,
        maxUsd: cap.max,
        usedToday: cap.used,
        remainingToday: cap.remaining,
      },
      { status: cap.code === "CAP_CHECK_UNAVAILABLE" ? 503 : 400 }
    );
  }

  const bank = resolveLinqBank(String(body.bankCode ?? ""));
  if (!bank) {
    return NextResponse.json({ error: "unknown bank" }, { status: 400 });
  }

  const accountNumber = String(body.accountNumber ?? "").trim();
  if (!ACCT_RE.test(accountNumber)) {
    return NextResponse.json(
      { error: "account number must be 6–12 digits" },
      { status: 400 }
    );
  }
  const accountName =
    typeof body.accountName === "string" && body.accountName.trim()
      ? body.accountName.trim().slice(0, MAX_NAME)
      : null;

  // Don't accept a payout request the user can't fund. The USDsui is collected
  // out-of-band at fulfilment, so guard here against an unbacked request.
  const { usdsui: spendable } = await getUsdsuiBalance(user.sui_address);
  if (amountUsdsui > spendable + 1e-9) {
    return NextResponse.json(
      { error: `amount exceeds your balance ($${spendable.toFixed(2)} available)` },
      { status: 400 }
    );
  }

  // Notional NGN at the reference rate, the founder confirms the live rate at
  // payout. amount_ngn / rate are NOT NULL on the table, so we fill both.
  const fxRate = FX.NGN;
  const ngn = Math.round(amountUsdsui * fxRate);

  await ensureSchema();
  const id = reqId();
  // Concierge rows live in `linq_offramps` too, distinguished by status. There
  // is no Linq order or deposit wallet for a manual request, so we store a
  // sentinel for the NOT-NULL linq_order_id / wallet_address columns.
  const now = Date.now();
  await db().execute({
    sql: `INSERT INTO linq_offramps
            (id, linq_order_id, user_id, amount_usdsui, amount_ngn, rate, bank_code,
             bank_account_number, bank_account_name, wallet_address, status, status_reason,
             created_at, updated_at)
          VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?, 'manual', 'manual_requested',
                  'concierge: awaiting manual NGN payout', ?, ?)`,
    args: [
      id,
      String(userId),
      amountUsdsui,
      ngn,
      fxRate,
      bank.bankCode,
      accountNumber,
      accountName,
      now,
      now,
    ],
  });

  // Also record it in the cross-rail attempt ledger so a concierge payout
  // consumes the same daily allowance as every other rail. Without this the
  // "concierge doesn't count toward the cap" carve-out means the cap can be
  // sidestepped indefinitely by using this route.
  try {
    await recordAttempt({
      id,
      userId,
      provider: "concierge",
      corridor: "NGN",
      usdAmount: amountUsdsui,
      destAmount: ngn,
      providerRef: id,
      state: "manual_requested",
    });
  } catch (e) {
    console.warn("[offramp/request] attempt ledger failed:", (e as Error).message);
  }

  // GROWTH: the concierge rail is a cash-out too, and leaving it out would make
  // `cashout_started` under-report by exactly the manual payouts. Emitted after
  // the row is persisted, so it can only describe a request that really exists.
  trackCashoutStarted(userId, {
    usd: amountUsdsui,
    corridor: "NGN",
    provider: "concierge",
  });

  await notifyFounder({
    id,
    user: user.email ?? String(userId),
    handle: user.talise_username ? `@${user.talise_username}` : "-",
    usdsui: amountUsdsui,
    ngn,
    bank: bank.name,
    account: accountNumber,
    name: accountName ?? "-",
  });

  return NextResponse.json({
    ok: true,
    id,
    status: "manual_requested",
    message: `Cash-out request received, we'll confirm the live rate and send your naira to your ${bank.name} account shortly.`,
  });
}
