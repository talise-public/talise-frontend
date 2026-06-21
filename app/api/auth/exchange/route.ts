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
 * POST /api/auth/exchange { code, state } → { ok, dest } | { ok:false, err }
 *
 * The WEB half of the OAuth callback. /auth/callback bounces the browser to
 * /auth/finish (the staged-loader page) without doing any work; that page
 * POSTs the code+state here, so the loader animates while THIS request runs
 * the real exchange (Google → Shinami wallet → upsert → cookies).
 *
 * State is validated against the same httpOnly cookie the authorize leg set —
 * identical CSRF posture to the old single-request flow, just split across
 * two requests of the same browser session.
 */
export async function POST(req: Request) {
  let body: { code?: string; state?: string };
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
      // Web uses the static env redirect URI — it must match what the client
      // used at authorize-time (Vercel may 307 apex↔www between legs).
      redirectUri: googleRedirectUri(),
      country: req.headers.get("x-vercel-ip-country"),
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
