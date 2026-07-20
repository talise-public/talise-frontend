// DISABLED (2026-06-07): this legacy, UNAUTHENTICATED email-POST endpoint was
// the spam vector, a single datacenter IP fed junk addresses (test@test.com,
// *@example.com, ...) straight into `waitlist_signups` and triggered an
// outbound confirmation email per address. The product's real flow is now
// Google-first: sign in → pick a handle → POST /api/waitlist/handle/claim,
// which derives the email from the authenticated session (no spoofable email
// body, no junk). Nothing in the app calls this route anymore (verified:
// WaitlistForm.tsx uses /api/auth/me + /api/waitlist/handle/{availability,claim}).
//
// So we hard-disable it: every method returns 410 Gone, no body parse, no DB
// write, no email send, zero attack surface. To restore the old email-signup
// behavior, `git revert` the commit that introduced this change.
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GONE = {
  error:
    "This sign-up endpoint has been retired. Join the waitlist at /waitlist (sign in with Google).",
} as const;

function gone() {
  return NextResponse.json(GONE, {
    status: 410,
    headers: {
      // Tell crawlers/clients not to keep hitting it.
      "Cache-Control": "no-store",
    },
  });
}

export const POST = gone;
export const GET = gone;
export const PUT = gone;
export const PATCH = gone;
export const DELETE = gone;
