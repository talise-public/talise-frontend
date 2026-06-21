import { NextResponse } from "next/server";
import { db, userById } from "@/lib/db";
import { getClientIp, rateLimitAsync } from "@/lib/rate-limit";
import { readSessionEntryId } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/waitlist/handle/existing
 *
 * Auth-required: identity is derived SOLELY from the web session cookie.
 * The endpoint NEVER accepts an email (or any identifier) from the
 * request — so it cannot be turned into an "is this email on the
 * waitlist / does it own a handle" enumeration oracle. A caller can only
 * ever learn about THEIR OWN claim.
 *
 * Returns:
 *   200 { existing: { handle: "alice" } }   — caller already has a handle
 *   200 { existing: null }                   — caller has no handle (or not signed in)
 *
 * Source of truth is `users.talise_username` (the USER's name), with a
 * fallback to `waitlist_signups.claimed_handle` keyed by the session
 * user's email so pre-existing/legacy claims are reported reliably even
 * if the user row hasn't been backfilled yet.
 *
 * Called by the waitlist form. If an existing handle is found, the form
 * swaps the claim UI for a "welcome back" card rather than prompting for
 * a new handle (which would later 409 against the one they already own).
 */
export async function GET(req: Request) {
  const ip = getClientIp(req);
  const rl = await rateLimitAsync({
    key: `waitlist-handle-existing:${ip}`,
    limit: 30,
    windowSec: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests." },
      {
        status: 429,
        headers: { "Retry-After": String(rl.retryAfterSec ?? 60) },
      }
    );
  }

  const userId = await readSessionEntryId();
  if (!userId) {
    // Not signed in → nothing to report. Intentionally NOT a 401: the
    // form races this probe on mount and treats "no existing handle"
    // and "not signed in" identically (both → show the claim CTA once
    // the user signs in).
    return NextResponse.json({ existing: null });
  }

  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ existing: null });
  }

  // Primary source of truth: the USER's canonical handle.
  if (user.talise_username) {
    return NextResponse.json({ existing: { handle: user.talise_username } });
  }

  // Fallback: a legacy/pre-existing claim recorded on the waitlist row
  // keyed by this session user's email. Reported only when truly minted
  // on chain (handle_object_id set), matching what a SuiNS resolver
  // already exposes publicly.
  const email = (user.email ?? "").trim().toLowerCase();
  if (email) {
    try {
      const r = await db().execute({
        sql: `SELECT claimed_handle FROM waitlist_signups
                WHERE email = ?
                  AND claimed_handle IS NOT NULL
                  AND handle_object_id IS NOT NULL
                LIMIT 1`,
        args: [email],
      });
      const handle = r.rows[0]?.claimed_handle as string | undefined;
      if (handle) {
        return NextResponse.json({ existing: { handle } });
      }
    } catch (err) {
      console.warn(
        `[waitlist/handle/existing] lookup failed user=${user.id}: ${(err as Error).message}`
      );
    }
  }

  return NextResponse.json({ existing: null });
}
