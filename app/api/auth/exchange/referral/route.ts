import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import {
  attributeReferralInstrumented,
  normalizeReferralCode,
} from "@/lib/auth-exchange";
import { emitGrowthEvent } from "@/lib/referral-events";
import { rateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * POST /api/auth/exchange/referral { code } → { ok } | { ok:false, reason }
 *
 * The NATIVE half of referral attribution.
 *
 * Why this route has to exist: attribution used to read the signed httpOnly
 * `talise_ref` cookie, and a native app has no cookie jar. The iOS and Android
 * sign-in legs (`/api/auth/mobile/start` → `/auth/callback` → `talise://`, and
 * the direct `/api/auth/mobile/exchange` handshake) never carry that cookie, so
 * every mobile-originated invite was silently unattributed. The clients capture
 * the code from the invite deep link locally, then call this once, immediately
 * after their FIRST sign-in, with the bearer they were just issued.
 *
 * Anti-abuse. This must not become a "credit me to anyone" endpoint, so it is
 * strictly narrower than the browser path, not wider:
 *
 *   • Authenticated. The referee is taken from the bearer/session, never from
 *     the body, so you can only ever attribute YOURSELF.
 *   • First-sign-in only, server-decided. The account row must be younger than
 *     FIRST_SIGNIN_WINDOW_MS. A settled user cannot come back later and hand a
 *     friend a referral. The client's own "isNew" flag is never trusted.
 *   • One inviter, forever. `attributeReferral` claims the referee with an
 *     atomic compare-and-swap on `referred_by_user_id IS NULL`, so concurrent
 *     or repeated calls credit exactly one inviter once.
 *   • No self-referral. Rejected inside `attributeReferral`.
 *   • One Google account per referral still holds, `users.google_sub` is UNIQUE,
 *     so a farm needs a distinct real Google account per fake referee.
 *   • Rate limited per IP.
 *
 * Failures return HTTP 200 with `ok:false` and a reason. They are expected
 * (stale link, already attributed, own code) and a non-2xx would only make
 * clients retry a decision that will never change.
 */

/**
 * How long after account creation a native client may still claim an invite.
 * Generous enough to cover OAuth + onboarding + PIN setup on a slow phone,
 * short enough that it is unambiguously "the first sign-in".
 */
const FIRST_SIGNIN_WINDOW_MS = 30 * 60 * 1000;

export async function POST(req: Request) {
  const rl = rateLimit({
    key: `referral-claim:${getClientIp(req)}`,
    limit: 10,
    windowSec: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, reason: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } }
    );
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json(
      { ok: false, reason: "not authenticated" },
      { status: 401 }
    );
  }

  let body: { code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "bad json" }, { status: 400 });
  }

  const code = normalizeReferralCode(body.code);
  if (!code) {
    return NextResponse.json(
      { ok: false, reason: "invalid code" },
      { status: 400 }
    );
  }

  const user = await userById(userId);
  if (!user) {
    return NextResponse.json(
      { ok: false, reason: "user not found" },
      { status: 404 }
    );
  }

  // First-sign-in gate, decided from the stored row rather than anything the
  // client said. `created_at` is epoch ms (see lib/db.ts upsertUser).
  const age = Date.now() - Number(user.created_at ?? 0);
  if (!Number.isFinite(age) || age > FIRST_SIGNIN_WINDOW_MS) {
    await emitGrowthEvent("invite_attribution_failed", {
      userId,
      code,
      surface: "native",
      reason: "not first sign-in",
      accountAgeMs: Number.isFinite(age) ? age : null,
    });
    return NextResponse.json({ ok: false, reason: "not first sign-in" });
  }

  try {
    const result = await attributeReferralInstrumented(userId, code, "native");
    return NextResponse.json(
      result.ok ? { ok: true } : { ok: false, reason: result.reason }
    );
  } catch (err) {
    console.error(
      `[referral/claim] user=${userId} failed: ${(err as Error).message?.slice(0, 200)}`
    );
    return NextResponse.json(
      { ok: false, reason: "claim_failed" },
      { status: 500 }
    );
  }
}
