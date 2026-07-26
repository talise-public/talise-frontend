import "server-only";

import { createHash } from "node:crypto";
import { verifyAssertion } from "@/lib/app-attest-verify";
import { appAttestMode, bumpAttestCounter, getAttestedKey } from "@/lib/app-attest";
import { isMobileRequest } from "@/lib/mobile-sessions";
import { abuseLog } from "@/lib/abuse/log";

/**
 * Device attestation on the growth surface (referral / onboarding).
 *
 * Same MECHANISM as the money routes (`lib/app-attest.ts#requireAppAttest`,
 * used by /api/cheques/create): the iOS client's `APIClient` already sends
 * `X-App-Attest` (a DCAppAttestService assertion over SHA256(request body))
 * and `X-App-Attest-KeyId` on EVERY call, and we verify that assertion
 * against the registered public key in `app_attest_keys`, enforcing counter
 * monotonicity and the rpId — via the exact same `verifyAssertion` +
 * `getAttestedKey` + `bumpAttestCounter` primitives. No new crypto here.
 *
 * The only thing that differs is the trigger and the kill switch:
 *
 *   • Trigger — `app-attest.ts` gates on `APP_ATTEST_REQUIRED_PREFIXES`, a
 *     money-route list. Referral/onboarding are not money routes and must
 *     not be bolted onto that list: widening it would change enforcement
 *     for the structural gate too, and the two surfaces need to roll out
 *     independently. The prefixes below are this surface's own list.
 *
 *   • Kill switch — `TALISE_GROWTH_ATTEST_MODE`
 *     (off | log | enforce), defaulting to the money-route mode
 *     (`TALISE_APP_ATTEST_MODE`, itself "log" by default) so the growth
 *     surface never blocks harder than the surface that has been
 *     device-validated. Flip it to "enforce" only after the money routes
 *     are enforcing, otherwise a legacy key that hasn't re-attested would
 *     turn a first-run onboarding into a 401 — i.e. a dead app.
 *
 * WHY here at all: a referral farm's cheapest form is a script POSTing
 * signups/attributions with a stolen bearer. Rate limits raise the cost per
 * IP; attestation raises it to "must be a real, un-jailbroken iPhone build".
 *
 * Web browsers are untouched — `isMobileRequest` (Bearer header) is the same
 * mobile test the auth layer uses, so a browser hitting /r/CODE or the
 * landing page's capture call never sees this gate.
 */

/** Growth-surface paths that require a device assertion from MOBILE callers. */
export const GROWTH_ATTEST_PREFIXES: readonly string[] = [
  "/api/referral/",
  "/api/onboarding",
];

export function pathRequiresGrowthAttest(pathname: string): boolean {
  return GROWTH_ATTEST_PREFIXES.some((p) => pathname.startsWith(p));
}

/** off = disabled, log = verify + log only, enforce = 401 on failure. */
export function growthAttestMode(): "off" | "log" | "enforce" {
  const raw = process.env.TALISE_GROWTH_ATTEST_MODE?.toLowerCase();
  if (raw === "enforce") return "enforce";
  if (raw === "log") return "log";
  if (raw === "off") return "off";
  // Unset → inherit the money-route mode (default "log").
  return appAttestMode();
}

/**
 * Gate a growth route on device attestation.
 *
 * Call it exactly like the money routes do: read the raw body ONCE, hand
 * the same string here, then parse it (the assertion signs
 * SHA256(rawBody), so re-serialising a parsed object would not match).
 * Pass "" for GET routes — the iOS client hashes an empty body there.
 *
 * Returns null when the request may proceed, or a 401 Response when the
 * gate is enforcing and verification failed.
 */
export async function requireGrowthAttest(
  req: Request,
  rawBody: string
): Promise<Response | null> {
  const mode = growthAttestMode();
  if (mode === "off") return null;
  // Browser traffic (cookie session) is out of scope for App Attest.
  if (!isMobileRequest(req)) return null;
  const { pathname } = new URL(req.url);
  if (!pathRequiresGrowthAttest(pathname)) return null;
  // Same simulator/staging escape hatch as the money routes:
  // DCAppAttestService.isSupported is false in the iOS Simulator, so without
  // this every sim build would 401.
  if (process.env.TALISE_APP_ATTEST_REQUIRED === "0") return null;

  const fail = (
    event: "attest_missing" | "attest_invalid",
    msg: string
  ): Response | null => {
    abuseLog(event, {
      route: pathname,
      mode,
      action: mode === "log" ? "allow" : "deny",
      detail: msg,
    });
    if (mode === "log") return null;
    return new Response(JSON.stringify({ error: msg }), {
      status: 401,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  };

  const assertion = req.headers.get("x-app-attest");
  const keyId = req.headers.get("x-app-attest-keyid");
  if (!assertion || !keyId) return fail("attest_missing", "missing App Attest headers");

  try {
    const stored = await getAttestedKey(keyId);
    if (!stored || !stored.publicKeyB64) {
      // Unknown key, or a legacy key registered before verification existed
      // → ask the client to re-bootstrap rather than hard-failing forever.
      return fail("attest_invalid", "attest_reregister");
    }
    const clientDataHash = createHash("sha256").update(rawBody, "utf8").digest();
    const { newCounter } = verifyAssertion({
      assertionBase64: assertion,
      clientDataHash,
      publicKeyDer: Buffer.from(stored.publicKeyB64, "base64"),
      storedCounter: stored.counter,
    });
    await bumpAttestCounter(keyId, newCounter);
    return null;
  } catch (e) {
    return fail("attest_invalid", `assertion invalid: ${(e as Error).message}`);
  }
}
