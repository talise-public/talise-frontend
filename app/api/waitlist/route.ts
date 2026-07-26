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
import { abuseLog } from "@/lib/abuse/log";
import { clientIpFromHeaders } from "@/lib/abuse/ip-reputation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GONE = {
  error:
    "This sign-up endpoint has been retired. Join the waitlist at /waitlist (sign in with Google).",
} as const;

// Deliberately NOT rate-limited: a 410 with no body parse, no DB touch and
// no email send is already cheaper than any limiter check would be (a
// Postgres/Redis round-trip per request would make a flood MORE expensive
// for us, not less). What was missing is visibility — a resumed flood on the
// original spam vector should be obvious in the logs. So we log with the
// standard `[abuse]` prefix, SAMPLED (first hit per instance, then every
// 100th) so the flood itself can't turn into a log-volume bill.
let goneHits = 0;
const LOG_EVERY = 100;

// The first argument must be a required `Request` — Next.js validates route
// handler signatures at build time and rejects an optional first param
// ("Type 'Request | undefined' is not a valid type for the function's first
// argument"). The unit test that locks in this 410 contract
// (__tests__/sui/waitlist-turnstile) passes a Request, so nothing needs it to
// be optional; the internals stay defensive in case it is ever called bare.
function gone(req: Request) {
  goneHits += 1;
  if (goneHits === 1 || goneHits % LOG_EVERY === 0) {
    abuseLog("rate_limited", {
      route: "waitlist-retired",
      action: "gone_410",
      ip: req ? clientIpFromHeaders(req.headers) : "unknown",
      method: req?.method,
      hits_this_instance: goneHits,
    });
  }
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
