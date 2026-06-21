import { NextResponse } from "next/server";
import { readReferralCookie } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Returns the referral code currently stored in the httpOnly cookie (if any),
 * so the onboarding form can pre-fill the field. The client can't read the
 * cookie directly because it's httpOnly + signed.
 */
export async function GET() {
  const code = await readReferralCookie();
  return NextResponse.json({ code });
}
