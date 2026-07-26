import { NextResponse } from "next/server";
import { googleRedirectUri } from "@/lib/auth";
import {
  clearStateCookie,
  consumeReturnTo,
  readStateCookie,
} from "@/lib/session";
import { completeSignIn } from "@/lib/auth-exchange";

export const runtime = "nodejs";

/**
 * POST /api/auth/exchange { code, state, ref? } → { ok, dest } | { ok:false, err }
 *
 * The WEB half of the OAuth callback. /auth/callback bounces the browser to
 * /auth/finish (the staged-loader page) without doing any work; that page
 * POSTs the code+state here, so the loader animates while THIS request runs
 * the real exchange (Google → Shinami wallet → upsert → cookies).
 *
 * State is validated against the same httpOnly cookie the authorize leg set -
 * identical CSRF posture to the old single-request flow, just split across
 * two requests of the same browser session.
 *
 * `ref` is OPTIONAL and additive: the signed `talise_ref` cookie remains the
 * primary web signal, but a caller that already knows the inviter's code can
 * pass it here. That covers the browsers where a `.talise.io` cookie does not
 * survive the hop (ITP/third-party-cookie blocking, a private window opened
 * from the invite), and it is the same parameter any non-browser client uses.
 * It is NOT trusted beyond the existing guards: `attributeReferral` still
 * rejects self-referral and still requires the atomic
 * `referred_by_user_id IS NULL` claim, and it only runs on a FIRST sign-in.
 */
export async function POST(req: Request) {
  let body: { code?: string; state?: string; ref?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, err: "bad_json" }, { status: 400 });
  }
  const code = (body.code ?? "").trim();
  const state = (body.state ?? "").trim();
  if (!code || !state) {
    return NextResponse.json({ ok: false, err: "missing_code" }, { status: 400 });
  }

  const expected = await readStateCookie();
  if (!expected || expected !== state) {
    return NextResponse.json({ ok: false, err: "bad_state" }, { status: 403 });
  }
  await clearStateCookie();

  try {
    const result = await completeSignIn({
      code,
      // Web uses the static env redirect URI, it must match what the client
      // used at authorize-time (Vercel may 307 apex↔www between legs).
      redirectUri: googleRedirectUri(),
      country: req.headers.get("x-vercel-ip-country"),
      ref: body.ref ?? null,
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, err: result.err }, { status: 401 });
    }
    const { user } = result;

    // Destination priority (unchanged from the old callback):
    //   1. Explicit returnTo cookie (payment link, /waitlist CTA, …).
    //   2. account_type → /business or /app for fully-set-up users.
    //   3. Brand-new users with neither → /waitlist (canonical first step).
    const returnTo = await consumeReturnTo();
    const dest =
      returnTo ??
      (user.account_type === "business"
        ? "/business/dashboard"
        : user.account_type === "personal"
          ? "/app"
          : "/waitlist");

    return NextResponse.json({ ok: true, dest });
  } catch (err) {
    console.error(
      `[auth/exchange] sign-in failed: ${(err as Error).message?.slice(0, 200)}`
    );
    return NextResponse.json(
      { ok: false, err: "signin_failed" },
      { status: 500 }
    );
  }
}
