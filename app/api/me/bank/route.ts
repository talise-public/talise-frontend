import { NextResponse } from "next/server";

import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { getLinkedBankAccounts } from "@/lib/bank-accounts";

export const runtime = "nodejs";

/**
 * GET /api/me/bank
 *
 * List the caller's linked NGN bank accounts (off-ramp Phase 2), masked.
 *
 * Response: 200
 *   {
 *     accounts: [
 *       {
 *         id: string,
 *         bankCode: string,
 *         bankName: string,        // resolveLinqBank(bankCode) ?? bankCode
 *         accountName: string | null,
 *         last4: string,
 *         attested: boolean        // true once a consent signature is stored
 *       },
 *       ...
 *     ]
 *   }
 */
export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const rl = await rateLimitAsync({
    key: `me-bank-list:user:${userId}`,
    limit: 60,
    windowSec: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } }
    );
  }

  try {
    const accounts = await getLinkedBankAccounts(userId);
    return NextResponse.json({ accounts });
  } catch (e) {
    console.warn("[me/bank] list failed:", (e as Error).message);
    return NextResponse.json(
      { error: "Could not load linked accounts." },
      { status: 500 }
    );
  }
}
