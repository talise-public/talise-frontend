import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export function googleClientId(): string {
  const v = process.env.GOOGLE_CLIENT_ID;
  if (!v) throw new Error("GOOGLE_CLIENT_ID is not set");
  return v;
}

export function googleClientSecret(): string {
  const v = process.env.GOOGLE_CLIENT_SECRET;
  if (!v) throw new Error("GOOGLE_CLIENT_SECRET is not set");
  return v;
}

export function googleRedirectUri(): string {
  const v = process.env.GOOGLE_REDIRECT_URI;
  if (!v) throw new Error("GOOGLE_REDIRECT_URI is not set");
  return v;
}

/**
 * Derive the OAuth redirect URI from the incoming request's host. Used by
 * server-side flows that want the redirect to land back on whichever host
 * the user is talking to, e.g. mobile sign-in routes through
 * `app.talise.io/auth/callback`, the web flow stays on
 * `talise.io/auth/callback`. Both hosts must be registered as Authorized
 * Redirect URIs in Google Cloud Console.
 *
 * Note: Vercel forwards the original host header, so `new URL(req.url).host`
 * is reliable behind their proxy.
 */
export function redirectUriFromRequest(req: Request): string {
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}/auth/callback`;
}

function sessionSecret(): Buffer {
  const v = process.env.SESSION_SECRET;
  if (!v || v.length < 16) throw new Error("SESSION_SECRET must be set (>=16 chars)");
  return Buffer.from(v);
}

/** Sign a payload with HMAC. Used for state + session tokens. */
export function sign(payload: string): string {
  const mac = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function verify(signed: string): string | null {
  const lastDot = signed.lastIndexOf(".");
  if (lastDot < 0) return null;
  const payload = signed.slice(0, lastDot);
  const mac = signed.slice(lastDot + 1);
  const expected = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? payload : null;
}

export function newStateToken(): string {
  return randomBytes(16).toString("base64url");
}

export function buildGoogleAuthUrl(state: string, redirectUri?: string): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", googleClientId());
  u.searchParams.set("redirect_uri", redirectUri ?? googleRedirectUri());
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("access_type", "online");
  u.searchParams.set("prompt", "select_account");
  u.searchParams.set("state", state);
  return u.toString();
}

/**
 * Exchange the auth code for tokens. Google enforces that `redirect_uri`
 * here matches the value sent in the initial auth request, callers should
 * pass `redirectUriFromRequest(req)` so both legs use the same host.
 */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri?: string
): Promise<{
  id_token: string;
  access_token?: string;
  expires_in?: number;
}> {
  const body = new URLSearchParams({
    code,
    client_id: googleClientId(),
    client_secret: googleClientSecret(),
    redirect_uri: redirectUri ?? googleRedirectUri(),
    grant_type: "authorization_code",
  });
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Google token exchange failed: ${r.status} ${text}`);
  }
  return (await r.json()) as { id_token: string; access_token?: string; expires_in?: number };
}
