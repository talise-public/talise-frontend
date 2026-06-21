import { NextResponse } from "next/server";
import { redirectUriFromRequest } from "@/lib/auth";
import { clearStateCookie, readStateCookie } from "@/lib/session";
import { completeSignIn } from "@/lib/auth-exchange";
import { issueMobileBearer } from "@/lib/mobile-sessions";

export const runtime = "nodejs";

/**
 * GET /auth/callback — Google's OAuth redirect target.
 *
 * Two flows split here:
 *
 *   • WEB: we do NO work on this request. The user is bounced instantly to
 *     /auth/finish (a client page with a staged loader) which POSTs the
 *     code+state to /api/auth/exchange — so the "Verifying with Google →
 *     Securing your wallet → …" steps animate WHILE the real exchange runs,
 *     instead of the user staring at a blank tab for the whole round trip.
 *     The state cookie is validated + consumed by the exchange API.
 *
 *   • MOBILE (state minted by /api/auth/mobile/start with an `m1.` prefix):
 *     unchanged single-request flow — ASWebAuthenticationSession needs a
 *     plain HTTP redirect to the talise:// scheme, so we run the full
 *     exchange here and bounce with the bearer.
 */
function redirectAuthError(
  req: Request,
  state: string | null,
  err: string
): NextResponse {
  if (state && state.startsWith("m1.")) {
    const callback = new URL("talise://auth/callback");
    callback.searchParams.set("err", err);
    return NextResponse.redirect(callback.toString());
  }
  return NextResponse.redirect(
    new URL(`/?err=${encodeURIComponent(err)}`, req.url)
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    // Never forward a raw, attacker-controllable provider error string into
    // the landing banner. Legit OAuth errors are lowercase_snake codes; pass
    // only a sanitized code, else a generic one. (The render side maps codes
    // to fixed copy too — defense in depth.)
    const safe = /^[a-z_]{1,40}$/.test(error) ? error : "oauth_error";
    return redirectAuthError(req, state, safe);
  }
  if (!code || !state) {
    return redirectAuthError(req, state, "missing_code");
  }

  // ── WEB: hand off to the staged-loader page WITHOUT consuming the state
  // cookie — /api/auth/exchange validates + clears it. No work happens on
  // this request, so the bounce is instant.
  if (!state.startsWith("m1.")) {
    const finish = new URL("/auth/finish", req.url);
    finish.searchParams.set("code", code);
    finish.searchParams.set("state", state);
    return NextResponse.redirect(finish);
  }

  // ── MOBILE: unchanged single-request flow.
  const expected = await readStateCookie();
  if (!expected || expected !== state) {
    return redirectAuthError(req, state, "bad_state");
  }
  await clearStateCookie();

  try {
    const result = await completeSignIn({
      code,
      // Mobile derives the redirect URI from the request host.
      redirectUri: redirectUriFromRequest(req),
      country: req.headers.get("x-vercel-ip-country"),
    });
    if (!result.ok) {
      return redirectAuthError(req, state, result.err);
    }
    const { user, idToken, isNew } = result;

    // Read the (ephPubKey, maxEpoch, randomness) triple stashed by
    // /api/auth/mobile/start. These are the EXACT values that bound
    // the JWT's nonce; we must persist them so future proof mints
    // recompute the same Poseidon hash the Shinami prover sees in
    // jwt.nonce. Without this every send fails -32602 Invalid params.
    const { cookies: cookieJar } = await import("next/headers");
    const { verify } = await import("@/lib/auth");
    const jar = await cookieJar();
    const bindingRaw = jar.get("talise_m1_binding")?.value;
    let bindingPubKey: string | null = null;
    let bindingMaxEpoch: number | null = null;
    let bindingRandomness: string | null = null;
    if (bindingRaw) {
      const verified = verify(bindingRaw);
      if (verified) {
        try {
          const decoded = JSON.parse(
            Buffer.from(verified, "base64url").toString("utf8")
          );
          bindingPubKey = decoded.ephemeralPubKey ?? null;
          bindingMaxEpoch =
            typeof decoded.maxEpoch === "number" ? decoded.maxEpoch : null;
          bindingRandomness = decoded.randomness ?? null;
        } catch {
          // Malformed — fall through; signing still works but a
          // future send will need its own randomness generation.
        }
      }
    }
    jar.delete("talise_m1_binding");

    const bearer = await issueMobileBearer(user.id, {
      jwt: idToken,
      salt: user.salt,
      ephemeralPubKeyB64: bindingPubKey ?? undefined,
      maxEpoch: bindingMaxEpoch ?? undefined,
      randomness: bindingRandomness ?? undefined,
    });
    const callback = new URL("talise://auth/callback");
    callback.searchParams.set("token", bearer);
    callback.searchParams.set("userId", String(user.id));
    // Additive: tells iOS whether this Google account already had a
    // Talise user row (returning sign-in) vs was created by this
    // exchange (genuinely new). Old clients ignore unknown params.
    callback.searchParams.set("existing", isNew ? "0" : "1");
    return NextResponse.redirect(callback.toString());
  } catch (err) {
    // Log the real cause server-side; never reflect raw exception text (it can
    // echo provider token-endpoint detail) into the client-facing ?err=.
    console.error(
      `[auth/callback] sign-in failed: ${(err as Error).message?.slice(0, 200)}`
    );
    return redirectAuthError(req, state, "signin_failed");
  }
}
