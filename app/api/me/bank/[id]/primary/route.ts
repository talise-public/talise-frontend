import { NextResponse } from "next/server";

import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { setPrimaryBankAccount } from "@/lib/bank-accounts";

export const runtime = "nodejs";

/**
 * POST /api/me/bank/[id]/primary
 *
 * Make one of the caller's linked NGN bank accounts their PRIMARY payout
 * target — the bank a sender hits when they choose "pay to their bank"
 * against this user's @handle. Sets `is_primary = true` on this row and
 * unsets every other one of the caller's accounts (two statements as a
 * logical transaction). Scoped to the caller: targeting a row that isn't
 * theirs (or doesn't exist) returns 404 and changes nothing.
 *
 * Response: 200 { ok: true }
 * Errors:
 *   400  missing id
 *   401  not authenticated
 *   404  no such account for this user
 *   429  rate limited
 *   500  update failed
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const rl = await rateLimitAsync({
    key: `me-bank-primary:user:${userId}`,
    limit: 30,
    windowSec: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } }
    );
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "missing id" }, { status: 400 });
  }

  try {
    const ok = await setPrimaryBankAccount(userId, id);
    if (!ok) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.warn("[me/bank/:id/primary] set failed:", (e as Error).message);
    return NextResponse.json(
      { error: "Could not set the primary account." },
      { status: 500 }
    );
  }
}
