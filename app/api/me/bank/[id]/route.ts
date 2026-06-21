import { NextResponse } from "next/server";

import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { deleteBankAccount } from "@/lib/bank-accounts";

export const runtime = "nodejs";

/**
 * DELETE /api/me/bank/[id]
 *
 * Unlink one of the caller's linked NGN bank accounts. Scoped to the
 * caller — deleting a row that isn't theirs (or doesn't exist) returns
 * 404, never touches another user's row.
 *
 * Response: 200 { ok: true }
 * Errors:
 *   401  not authenticated
 *   404  no such account for this user
 *   429  rate limited
 *   500  delete failed
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const rl = await rateLimitAsync({
    key: `me-bank-delete:user:${userId}`,
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
    const deleted = await deleteBankAccount(userId, id);
    if (!deleted) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.warn("[me/bank/:id] delete failed:", (e as Error).message);
    return NextResponse.json(
      { error: "Could not unlink the account." },
      { status: 500 }
    );
  }
}
