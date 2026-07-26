import { NextResponse } from "next/server";
import { readSessionEntryId } from "@/lib/session";
import { userById, ensureReferralCode, getWaitlistRank } from "@/lib/db";
import { guardGrowthRoute } from "@/lib/abuse/guard";
import { WAITLIST_STATUS_IP, WAITLIST_STATUS_USER } from "@/lib/abuse/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/waitlist/status
 *
 * Web-session-only snapshot powering the post-claim waitlist dashboard:
 * the user's referral code, verified referral count, and live waitlist
 * position (more referrals → closer to the front). Mirrors /api/auth/me's
 * session model (readSessionEntryId, cookie only, no bearer).
 *
 * Shape:
 *   { signedIn: false }
 *   { signedIn: true, email, handle, referralCode, referralCount,
 *     position, total }
 *
 * ABUSE (2026-07-24): was unmetered, and `getWaitlistRank` ranks over the
 * whole signup table — the most expensive query on the waitlist surface.
 * Metered per user + per IP through the durable growth guard. Limits are
 * applied AFTER the session check so an unauthenticated prober can't burn a
 * signed-in user's allowance.
 */
export async function GET(req: Request) {
  const userId = await readSessionEntryId();
  if (!userId) {
    return NextResponse.json({ signedIn: false }, { status: 401 });
  }

  const guard = await guardGrowthRoute({
    req,
    route: "waitlist-status",
    userId,
    ip: WAITLIST_STATUS_IP,
    user: WAITLIST_STATUS_USER,
  });
  if (!guard.ok) return guard.response;

  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ signedIn: false }, { status: 401 });
  }

  // Guarantee a referral code exists, most rows get one at upsert, but
  // ensureReferralCode is idempotent and backfills any older row that doesn't.
  const referralCode = await ensureReferralCode(userId, user.name ?? user.email);
  const { position, total } = await getWaitlistRank(userId);

  return NextResponse.json({
    signedIn: true,
    email: user.email,
    handle: user.talise_username ?? null,
    referralCode,
    referralCount: Number(user.referral_count ?? 0) || 0,
    position,
    total,
  });
}
