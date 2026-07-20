import { NextResponse } from "next/server";
import { setReferralCookie } from "@/lib/session";
import { REFERRAL_CODE_RE } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Persist a referral code captured from `?ref=` on the landing page into an
 * httpOnly cookie (signed, 30-day TTL). Called by `<Hero>` on mount.
 *
 * We do NOT look up the inviter here, that happens at onboarding time when
 * the user actually picks an account type, so an invalid code can be caught
 * with a clean message instead of silently dying.
 */
export async function POST(req: Request) {
  let body: { code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const code = (body.code ?? "").trim().toUpperCase();
  if (!REFERRAL_CODE_RE.test(code)) {
    return NextResponse.json({ error: "invalid code" }, { status: 400 });
  }
  await setReferralCookie(code);
  return NextResponse.json({ ok: true });
}
