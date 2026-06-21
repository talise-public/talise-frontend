import { NextResponse } from "next/server";

import { userById } from "@/lib/db";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { verifyBank, linqConfigured } from "@/lib/linq";
import { resolveLinqBank } from "@/lib/linq-banks";

export const runtime = "nodejs";

/**
 * POST /api/offramp/linq/resolve
 *
 * Lightweight account name-enquiry — resolves the holder name for a
 * (bankCode, accountNumber) pair so the cash-out form can DETECT the name as
 * the user types (no manual "account name" entry). Amount-independent; the
 * full /quote still runs at review to lock the NGN figure.
 *
 * Body: { bankCode: string, accountNumber: string }  → { accountName, bankName }
 */
export async function POST(req: Request) {
  if (!linqConfigured()) {
    return NextResponse.json({ error: "off-ramp not configured" }, { status: 503 });
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // Name-enquiry hits the bank network — throttle per user.
  const rl = await rateLimitAsync({ key: `offramp-linq-resolve:user:${userId}`, limit: 20, windowSec: 60 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } }
    );
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: { bankCode?: string; accountNumber?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const bankCode = String(body.bankCode ?? "").trim();
  const accountNumber = String(body.accountNumber ?? "").trim();
  if (!resolveLinqBank(bankCode) || !/^\d{10}$/.test(accountNumber)) {
    return NextResponse.json(
      { error: "a known bankCode and a 10-digit accountNumber are required" },
      { status: 400 }
    );
  }

  try {
    const v = await verifyBank({ bankCode, accountNumber });
    return NextResponse.json({
      accountName: v.accountName,
      bankName: v.bankName || resolveLinqBank(bankCode)?.name || "",
      bankCode,
      accountNumber,
    });
  } catch (e) {
    console.warn("[offramp/linq/resolve] verifyBank failed:", (e as Error).message);
    return NextResponse.json({ error: "Could not verify that account." }, { status: 422 });
  }
}
