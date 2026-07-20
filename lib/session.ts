import { cookies } from "next/headers";
import { sign, verify } from "./auth";


/** Cookie Domain attribute. Set COOKIE_DOMAIN=.talise.io in production so the
 *  auth cookies (session / signing / oauth state / returnTo / referral) are
 *  shared across talise.io, www.talise.io AND app.talise.io, the OAuth
 *  callback runs on www, the app lives on the app subdomain. Unset locally and
 *  on previews (a mismatched Domain gets the cookie silently rejected). */
export function cookieDomain(): string | undefined {
  const d = process.env.COOKIE_DOMAIN?.trim();
  return d || undefined;
}
const SESSION_COOKIE = "talise_session";
const STATE_COOKIE = "talise_oauth_state";

export async function setStateCookie(state: string) {
  const jar = await cookies();
  jar.set(STATE_COOKIE, sign(state), {
    httpOnly: true,
    domain: cookieDomain(),
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 300,
  });
}

export async function readStateCookie(): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(STATE_COOKIE)?.value;
  if (!raw) return null;
  return verify(raw);
}

export async function clearStateCookie() {
  const jar = await cookies();
  jar.delete({ name: STATE_COOKIE, domain: cookieDomain(), path: "/" });
}

// Session lifetime. The old design signed JUST the user id with a 1-year
// maxAge and NO server-side expiry, a copied cookie worked ~forever and
// could not be revoked. Now the signed token carries an issued-at + expiry,
// checked on every read:
//   • IDLE   , the session slides forward while the user is active (each
//                /api/me refresh re-issues it); idle past this → logged out.
//   • ABSOLUTE, a hard ceiling from issue time; even an always-active session
//                must re-authenticate past this. This caps "forever" sessions.
const IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type Session = { id: number; iat: number; exp: number };

/**
 * Issue/refresh the session cookie. `iat` is preserved across refreshes so the
 * absolute cap is honored; pass it from an existing session when sliding.
 */
export async function setSessionCookie(entryId: number, iat?: number) {
  const now = Date.now();
  const issued = iat ?? now;
  const exp = Math.min(now + IDLE_TTL_MS, issued + ABSOLUTE_TTL_MS);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, sign(`${entryId}|${issued}|${exp}`), {
    httpOnly: true,
    domain: cookieDomain(),
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.max(0, Math.floor((exp - now) / 1000)),
  });
}

function parseSession(raw: string | undefined): Session | null {
  if (!raw) return null;
  const payload = verify(raw);
  if (!payload) return null;
  // `${id}|${iat}|${exp}`. A legacy id-only token (1 part) has no expiry →
  // treat as invalid so forever-sessions are retired (one re-login).
  const parts = payload.split("|");
  if (parts.length !== 3) return null;
  const id = Number(parts[0]);
  const iat = Number(parts[1]);
  const exp = Number(parts[2]);
  if (!Number.isFinite(id) || !Number.isFinite(iat) || !Number.isFinite(exp)) return null;
  const now = Date.now();
  if (now >= exp) return null; // idle-expired
  if (now >= iat + ABSOLUTE_TTL_MS) return null; // absolute-expired
  return { id, iat, exp };
}

export async function readSession(): Promise<Session | null> {
  const jar = await cookies();
  return parseSession(jar.get(SESSION_COOKIE)?.value);
}

export async function readSessionEntryId(): Promise<number | null> {
  return (await readSession())?.id ?? null;
}

/**
 * Sliding refresh: re-issue the cookie with a fresh idle window when the
 * current session is valid and past its half-life (avoids re-setting on every
 * poll), preserving `iat` so the absolute cap still bites. No-op if
 * expired/absent or already at the ceiling. Call from authenticated route
 * handlers (e.g. /api/me), they can set cookies; RSC layouts cannot.
 */
export async function refreshSessionCookie(): Promise<boolean> {
  const s = await readSession();
  if (!s) return false;
  const now = Date.now();
  if (s.exp - now > IDLE_TTL_MS / 2) return false; // still fresh enough
  if (now >= s.iat + ABSOLUTE_TTL_MS) return false; // at the hard ceiling
  await setSessionCookie(s.id, s.iat);
  return true;
}

export async function clearSession() {
  const jar = await cookies();
  jar.delete({ name: SESSION_COOKIE, domain: cookieDomain(), path: "/" });
}

const REFERRAL_COOKIE = "talise_ref";

/**
 * Persist a referral code captured from `?ref=` on the landing page. We sign
 * the value so a hostile client can't forge attribution. 30-day TTL, plenty
 * of time for a slow-to-decide visitor to come back and sign up.
 */
export async function setReferralCookie(code: string) {
  const jar = await cookies();
  jar.set(REFERRAL_COOKIE, sign(code), {
    httpOnly: true,
    domain: cookieDomain(),
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function readReferralCookie(): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(REFERRAL_COOKIE)?.value;
  if (!raw) return null;
  return verify(raw);
}

export async function clearReferralCookie() {
  const jar = await cookies();
  jar.delete({ name: REFERRAL_COOKIE, domain: cookieDomain(), path: "/" });
}

const RETURN_TO_COOKIE = "talise_return_to";

/**
 * Validate a `returnTo` value as a SAME-ORIGIN absolute path only.
 *
 * `path.startsWith("/")` alone is NOT enough, a protocol-relative URL
 * like `//evil.com` (and the backslash variant `/\evil.com`, which
 * browsers normalize to `//evil.com`) also starts with `/`, and
 * `new URL("//evil.com", origin)` resolves to `https://evil.com`. That
 * turns the post-sign-in redirect into an open redirect: an attacker
 * seeds the cookie, the victim completes a real Google consent screen,
 * and the callback 302s them to the attacker's domain, phishing-grade.
 *
 * Accept only: starts with a single `/`, NOT followed by `/` or `\`,
 * no backslashes anywhere, no control chars, ≤256 chars. Returns the
 * path if safe, else null.
 */
export function safeReturnPath(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.length > 256) return null;
  if (path[0] !== "/") return null;
  // protocol-relative ("//host") or backslash trick ("/\host")
  if (path[1] === "/" || path[1] === "\\") return null;
  if (path.includes("\\")) return null;
  // control chars (incl. CR/LF) and whitespace-leading tricks
  if (/[\x00-\x20\x7f]/.test(path)) return null;
  return path;
}

export async function setReturnTo(path: string) {
  const safe = safeReturnPath(path);
  if (!safe) return;
  const jar = await cookies();
  jar.set(RETURN_TO_COOKIE, sign(safe), {
    httpOnly: true,
    domain: cookieDomain(),
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600, // 10 minutes
  });
}

export async function consumeReturnTo(): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(RETURN_TO_COOKIE)?.value;
  if (!raw) return null;
  const v = verify(raw);
  jar.delete({ name: RETURN_TO_COOKIE, domain: cookieDomain(), path: "/" });
  // Re-validate on read too, defence in depth against a cookie minted
  // before this validation existed (or by any other writer).
  return safeReturnPath(v);
}
