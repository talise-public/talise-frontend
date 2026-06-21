import "server-only";
import { NextResponse } from "next/server";
import { userById, isAppAccessAllowed } from "./db";
import { memoTtl } from "./perf-cache";

/**
 * Private-beta API guardrail.
 *
 * The /app and /business layouts already gate the UI (waiting room), but a
 * signed-in-yet-unapproved user could still hit the money APIs directly with
 * their session cookie / bearer token. This helper closes that hole at the
 * chokepoints every value-moving action must pass through:
 *
 *   • /api/zk/sponsor + /api/zk/sponsor-execute   (all sponsored tx)
 *   • /api/send/gasless-submit (+ prepare routes)  (all gasless tx)
 *   • /api/offramp/linq/create + /to-user (+quote) (all cash-outs)
 *
 * Everything that moves money (sends, cheque/stream creation, payouts,
 * invoice payments, withdrawals, handle mints) funnels through one of those,
 * so gating them gates the product.
 *
 * Deliberately NOT gated: receiving money. Cheque claiming is worker-signed
 * server-side and invoice/pay/profile pages are public — non-members must be
 * able to RECEIVE funds; they just can't originate transactions until
 * approved (app_allowlist table / APP_ALLOWED_EMAILS env).
 *
 * Fail-closed: lookup errors deny. 60s memo per entry id keeps the hot path
 * at zero extra DB round-trips (a revoke takes ≤60s to bite — acceptable).
 */
export async function entryIsAppApproved(entryId: number): Promise<boolean> {
  try {
    return await memoTtl(`app-access:${entryId}`, 60_000, async () => {
      const u = await userById(entryId).catch(() => null);
      if (!u?.email) return false;
      return isAppAccessAllowed(u.email);
    });
  } catch {
    return false;
  }
}

/** 403 body shared by every gated route so clients can branch on `code`. */
export function appAccessDeniedResponse(): NextResponse {
  return NextResponse.json(
    {
      error:
        "Talise is in private beta — your account hasn't been approved yet. You're on the list; we open access in waves.",
      code: "APP_ACCESS",
    },
    { status: 403 }
  );
}

/**
 * One-liner for route handlers: returns a 403 NextResponse to short-circuit
 * with, or null when the user is approved.
 */
export async function denyUnlessAppApproved(
  entryId: number
): Promise<NextResponse | null> {
  return (await entryIsAppApproved(entryId)) ? null : appAccessDeniedResponse();
}
