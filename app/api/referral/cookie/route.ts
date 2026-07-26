import { NextResponse } from "next/server";
import { readReferralCookie } from "@/lib/session";
import { requireGrowthAttest } from "@/lib/abuse/attest";
import { guardGrowthRoute } from "@/lib/abuse/guard";
import { REFERRAL_COOKIE_IP } from "@/lib/abuse/limits";

export const runtime = "nodejs";

/**
 * Returns the referral code currently stored in the httpOnly cookie (if any),
 * so the onboarding form can pre-fill the field. The client can't read the
 * cookie directly because it's httpOnly + signed.
 *
 * ABUSE (2026-07-24): read-only and cheap, but it was unmetered, so it was a
 * free way to keep a lambda warm / probe the referral surface. Metered per IP
 * through the durable guard for consistency with the rest of the referral
 * path. GET has no body, so the attestation gate hashes "" — exactly what the
 * iOS client signs for a bodyless request.
 */
export async function GET(req: Request) {
  const guard = await guardGrowthRoute({
    req,
    route: "referral-cookie",
    ip: REFERRAL_COOKIE_IP,
  });
  if (!guard.ok) return guard.response;

  const attestBlock = await requireGrowthAttest(req, "");
  if (attestBlock) return attestBlock;

  const code = await readReferralCookie();
  return NextResponse.json({ code });
}
