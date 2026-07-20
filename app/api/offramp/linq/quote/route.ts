import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";

import { userById } from "@/lib/db";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { getRate, verifyBank, linqConfigured, checkDailyOfframpCap, cashoutFeatureOpen, CASHOUT_CLOSED_MESSAGE } from "@/lib/linq";
import { resolveLinqBank } from "@/lib/linq-banks";

export const runtime = "nodejs";

/**
 * POST /api/offramp/linq/quote
 *
 * Display quote for a USDSUI → NGN Linq off-ramp. Verifies the bank account
 * (name-enquiry) and prices the NGN the user will receive at the live rate.
 * No order is created yet (the rate is only LOCKED at /create time) and no
 * money moves, this just powers the review screen.
 *
 * Body: { amountUsdsui: number, bankCode: string, accountNumber: string }
 */
export async function POST(req: Request) {
  // Product gate (FEATURE_CASHOUT), closed for launch.
  if (!cashoutFeatureOpen()) {
    return NextResponse.json({ error: CASHOUT_CLOSED_MESSAGE, code: "CASHOUT_CLOSED" }, { status: 503 });
  }
  if (!linqConfigured()) {
    return NextResponse.json({ error: "off-ramp not configured" }, { status: 503 });
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // Private-beta guardrail: signed-in is not enough, the account must be on
  // the app allowlist before it can originate any value-moving call.
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  // Throttle bank name-enquiry (each call hits Linq + the bank network).
  const rl = await rateLimitAsync({ key: `offramp-linq-quote:user:${userId}`, limit: 12, windowSec: 60 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } }
    );
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: {
    amountNgn?: number;
    amountUsdsui?: number;
    bankCode?: string;
    accountNumber?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const reqNgn = Number(body.amountNgn);
  const reqUsdsui = Number(body.amountUsdsui);
  const wantsNgn = Number.isFinite(reqNgn) && reqNgn > 0;
  const wantsUsdsui = Number.isFinite(reqUsdsui) && reqUsdsui > 0;
  const bankCode = String(body.bankCode ?? "").trim();
  const accountNumber = String(body.accountNumber ?? "").trim();
  if (!wantsNgn && !wantsUsdsui) {
    return NextResponse.json(
      { error: "amountNgn or amountUsdsui must be positive" },
      { status: 400 }
    );
  }
  if (!bankCode || !/^\d{10}$/.test(accountNumber)) {
    return NextResponse.json(
      { error: "bankCode and a 10-digit accountNumber are required" },
      { status: 400 }
    );
  }
  if (!resolveLinqBank(bankCode)) {
    return NextResponse.json({ error: `unsupported bankCode "${bankCode}"` }, { status: 400 });
  }

  // Name-enquiry, surfaced inline next to the account field on a 422.
  let accountName: string;
  let bankName: string;
  try {
    const v = await verifyBank({ bankCode, accountNumber });
    accountName = v.accountName;
    bankName = v.bankName || resolveLinqBank(bankCode)?.name || "";
  } catch (e) {
    console.warn("[offramp/linq/quote] verifyBank failed:", (e as Error).message);
    return NextResponse.json({ error: "Could not verify the bank account." }, { status: 422 });
  }

  let rate: number;
  try {
    rate = (await getRate()).rate;
  } catch (e) {
    console.warn("[offramp/linq/quote] getRate failed:", (e as Error).message);
    return NextResponse.json({ error: "rate_unavailable" }, { status: 503 });
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    return NextResponse.json({ error: "rate_unavailable" }, { status: 503 });
  }

  // Quote either direction: NGN → the USDsui that will be debited, or
  // USDsui → the NGN the recipient gets. Display rate; the order locks its own.
  const amountUsdsui = wantsNgn
    ? Math.round((reqNgn / rate) * 1e6) / 1e6
    : Math.round(reqUsdsui * 1e6) / 1e6;
  const amountNgn = wantsNgn
    ? Math.round(reqNgn * 100) / 100
    : Math.round(reqUsdsui * rate * 100) / 100;

  // Per-account DAILY cap: $200/day across all cash-outs (KYC unlocks more).
  const cap = await checkDailyOfframpCap(userId, amountUsdsui);
  if (!cap.ok) {
    return NextResponse.json(
      { error: cap.error, code: cap.code, maxUsd: cap.max, usedToday: cap.used, remainingToday: cap.remaining },
      { status: 400 }
    );
  }

  return NextResponse.json({
    accountName,
    bankName,
    bankCode,
    accountNumber,
    rate,
    amountUsdsui,
    amountNgn,
    // Display only, the order locks its own rate at /create time.
    note: "Rate shown for display; locked when you confirm.",
  });
}
