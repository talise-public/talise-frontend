/**
 * Cloudflare Turnstile server-side verification.
 *
 * Used by the public, unauthenticated email-signup endpoint
 * (`POST /api/waitlist`) to close the outbound-email-spam amplification
 * vector (audit F9): without a captcha gate, a script can feed victim
 * addresses and make Talise email them.
 *
 * `verifyTurnstile` POSTs the client token to Cloudflare's siteverify
 * endpoint and returns whether it passed. The caller decides policy
 * (fail-closed when the secret is configured, fall back to rate-limit
 * only when it isn't — see the route). This module is intentionally
 * dumb: token in, boolean out.
 *
 * Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Whether a Turnstile secret is configured (i.e. verification is active). */
export function turnstileConfigured(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY?.trim());
}

/**
 * Verify a Turnstile token against Cloudflare's siteverify API.
 *
 * Returns `false` on any failure — missing secret, empty token, network
 * error, non-200, or `{ success: false }`. The route only calls this when
 * `turnstileConfigured()` is true, so a missing secret returning `false`
 * here is belt-and-suspenders.
 *
 * @param token the `cf-turnstile-response` token from the client widget.
 * @param ip optional client IP, forwarded to Cloudflare for extra signal.
 */
export async function verifyTurnstile(
  token: string,
  ip?: string
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return false;
  if (!token || typeof token !== "string") return false;

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (ip && ip !== "unknown") form.set("remoteip", ip);

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res.ok) {
      console.warn(`[turnstile] siteverify HTTP ${res.status}`);
      return false;
    }
    const data = (await res.json()) as {
      success?: boolean;
      "error-codes"?: string[];
    };
    if (!data.success) {
      console.warn(
        `[turnstile] verification failed codes=${(
          data["error-codes"] ?? []
        ).join(",")}`
      );
    }
    return data.success === true;
  } catch (err) {
    console.warn("[turnstile] siteverify exception:", (err as Error).message);
    return false;
  }
}
