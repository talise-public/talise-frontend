import "server-only";

import { after } from "next/server";
import { exchangeCodeForTokens } from "@/lib/auth";
import { decodeJwt, deriveSuiAddress, generateSalt } from "@/lib/zklogin";
import {
  upsertUser,
  userByGoogleSub,
  markNotified,
  realignAddress,
  attributeReferral,
  REFERRAL_CODE_RE,
} from "@/lib/db";
import { POINTS } from "@/lib/rewards";
import { shinamiEnabled, shinamiGetWallet } from "@/lib/shinami";
import {
  setSessionCookie,
  readReferralCookie,
  clearReferralCookie,
} from "@/lib/session";
import { sendWelcomeWithAddress } from "@/lib/email";
import { setSigningCookie } from "@/lib/zksigner";

/**
 * The shared core of Google → Talise sign-in, extracted VERBATIM from
 * /auth/callback so the web and mobile flows can't drift:
 *
 *   code → id_token → claims checks → Shinami salt/address → upsert →
 *   realign stale pairs → first-sign-in referral → waitlist handle bind →
 *   session + signing cookies → welcome email (after()).
 *
 * Callers finish the flow their own way: the web exchange API computes a
 * destination and returns JSON to the staged-loader page; the mobile branch
 * mints a bearer and bounces through talise://.
 */
export type SignInResult =
  | {
      ok: true;
      user: Awaited<ReturnType<typeof upsertUser>>["user"];
      idToken: string;
      isNew: boolean;
    }
  | { ok: false; err: string };

export async function completeSignIn(opts: {
  code: string;
  redirectUri: string;
  country: string | null;
}): Promise<SignInResult> {
  const { id_token } = await exchangeCodeForTokens(opts.code, opts.redirectUri);
  const claims = decodeJwt(id_token);

  if (claims.email_verified === false) {
    return { ok: false, err: "unverified_email" };
  }
  if (claims.aud !== process.env.GOOGLE_CLIENT_ID) {
    return { ok: false, err: "bad_audience" };
  }

  // Pick the salt source. Shinami manages salt server-side on mainnet
  // (their prover requires the address they assign), so we always resolve
  // through them when the key is configured. Otherwise fall back to a
  // locally-derived salt, fine for testnet, broken for mainnet.
  const existing = await userByGoogleSub(claims.sub);

  let salt: string;
  let suiAddress: string;
  if (shinamiEnabled()) {
    const wallet = await shinamiGetWallet(id_token);
    salt = wallet.salt;
    suiAddress = wallet.address;
  } else {
    salt = existing?.salt ?? generateSalt();
    suiAddress = existing?.sui_address ?? deriveSuiAddress(id_token, salt);
  }

  const { user, isNew } = await upsertUser({
    googleSub: claims.sub,
    email: claims.email,
    name: claims.name ?? null,
    picture: claims.picture ?? null,
    suiAddress,
    salt,
    country: opts.country,
  });

  // Migrate rows that carry a pre-Shinami salt/address pair. A stale pair
  // makes the account unusable because the proof won't anchor to it.
  if (!isNew && (user.sui_address !== suiAddress || user.salt !== salt)) {
    await realignAddress(user.id, suiAddress, salt);
    user.sui_address = suiAddress;
    user.salt = salt;
  }

  // Attribute a waitlist referral on the user's FIRST sign-in. Idempotent and
  // best-effort, never wedge sign-in.
  if (isNew) {
    try {
      const refCode = ((await readReferralCookie()) ?? "").trim().toUpperCase();
      if (REFERRAL_CODE_RE.test(refCode)) {
        await attributeReferral(user.id, refCode, {
          referrer: POINTS.REFERRAL_SIGNUP_REFERRER,
          referee: POINTS.REFERRAL_SIGNUP_REFEREE,
        });
      }
    } catch (e) {
      console.warn(`[sign-in/referral] ${user.email}: ${(e as Error).message}`);
    } finally {
      await clearReferralCookie();
    }
  }

  // Waitlist handle bind, same wallet on web and iOS, so either surface can
  // trigger the on-chain mint. Helper swallows errors internally.
  try {
    const { bindWaitlistHandleIfAny } = await import("@/lib/handle-claim");
    await bindWaitlistHandleIfAny({
      userId: user.id,
      userEmail: user.email,
      suiAddress: user.sui_address,
    });
  } catch (e) {
    console.warn(`[sign-in/handle-bind] ${user.email}: ${(e as Error).message}`);
  }

  await setSessionCookie(user.id);
  // Stash the JWT + salt server-side so /api/sign can call the prover
  // without ever exposing them to client JS.
  await setSigningCookie(id_token, user.salt);

  if (isNew && !user.notified_at) {
    after(async () => {
      const firstName = (user.name ?? "").split(/\s+/)[0] || null;
      const result = await sendWelcomeWithAddress(user.email, {
        firstName,
        suiAddress: user.sui_address,
        position: user.id,
      });
      if (result.ok) {
        await markNotified(user.id);
      } else {
        console.error(`[welcome-email] ${user.email}: ${result.reason}`);
      }
    });
  }

  return { ok: true, user, idToken: id_token, isNew };
}
