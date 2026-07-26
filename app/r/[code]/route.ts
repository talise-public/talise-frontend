import { NextRequest, NextResponse, after } from "next/server";
import { setReferralCookie } from "@/lib/session";
import { REFERRAL_CODE_RE } from "@/lib/db";
import { guardGrowthRoute } from "@/lib/abuse/guard";
import { REFERRAL_LINK_IP } from "@/lib/abuse/limits";
import { emitGrowthEvent } from "@/lib/referral-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Referral landing, `talise.io/r/<CODE>`.
 *
 * This path had no route, so every invite link 404'd. It now captures the
 * inviter's code into the signed, httpOnly `talise_ref` cookie (issued with
 * Domain=.talise.io, so it survives the hop to app.talise.io where sign-up
 * happens) and redirects to the landing. Actual attribution runs later, at
 * sign-in / onboarding, when the cookie is read (see auth-exchange.ts).
 *
 * Robustness: we ALSO forward `?ref=<CODE>` so the landing's existing client
 * capture (`/api/referral/capture`) fires too, either path alone attributes.
 * An invalid or unknown code still redirects cleanly (no 404); it just won't
 * attribute, and a bad code is caught with a friendly message at onboarding.
 *
 * ABUSE (added 2026-07-24): this is a public, unauthenticated write (it mints
 * a signed attribution cookie), and it was completely unmetered. It is now
 * rate-limited per IP through the durable growth guard — but a 429 on an
 * invite link would be a terrible first impression, and mobile CGNAT means
 * one IP can front a lot of real users. So over-limit DEGRADES instead of
 * erroring: the visitor still lands on the marketing page, we simply refuse
 * to write the attribution cookie / `?ref` param. That removes the only
 * thing a farm wants from this endpoint while costing a false positive
 * nothing but their referral credit.
 * This is the ONE canonical referral entry point. `/waitlist?ref=CODE` (the old
 * second loop, which 404s) now redirects here, and every share surface builds
 * `/r/<CODE>` from `components/app/rewards/share-copy.ts`.
 *
 * `/r/*` is also claimed by the apps (see the AASA + assetlinks routes under
 * app/.well-known), so on a device WITH Talise installed this URL opens the app
 * directly and the app captures the code itself; this handler is what runs for
 * everyone else.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code: raw } = await params;
  const code = (raw ?? "").trim().toUpperCase();

  const dest = new URL("/", req.url);

  const guard = await guardGrowthRoute({
    req,
    route: "referral-link",
    ip: REFERRAL_LINK_IP,
  });

  // Over limit / denied IP → redirect WITHOUT attributing. The guard already
  // logged the decision with the `[abuse]` prefix.
  if (!guard.ok) {
    return NextResponse.redirect(dest, { status: 307 });
  }

  if (REFERRAL_CODE_RE.test(code)) {
    await setReferralCookie(code);
    dest.searchParams.set("ref", code);
    // Top of the funnel. Without this we could count signups but not the clicks
    // that produced them. Deferred with `after()` so a click never waits on
    // telemetry: this route's whole job is to 307 as fast as possible.
    const host = req.headers.get("host");
    const referer = req.headers.get("referer");
    after(() => emitGrowthEvent("invite_clicked", { code, surface: "web", host, referer }));
  }
  return NextResponse.redirect(dest, { status: 307 });
}
