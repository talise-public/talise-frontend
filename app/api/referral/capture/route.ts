import { NextResponse } from "next/server";
import { setReferralCookie } from "@/lib/session";
import { REFERRAL_CODE_RE } from "@/lib/db";
import { requireGrowthAttest } from "@/lib/abuse/attest";
import { guardGrowthRoute } from "@/lib/abuse/guard";
import { REFERRAL_CAPTURE_IP } from "@/lib/abuse/limits";

export const runtime = "nodejs";

/**
 * Persist a referral code captured from `?ref=` on the landing page into an
 * httpOnly cookie (signed, 30-day TTL). Called by `<Hero>` on mount.
 *
 * We do NOT look up the inviter here, that happens at onboarding time when
 * the user actually picks an account type, so an invalid code can be caught
 * with a clean message instead of silently dying.
 *
 * ABUSE (2026-07-24): unauthenticated write, previously unmetered and with
 * no IP check at all. Now behind the durable growth guard (per-IP, global
 * across lambdas, FAILS CLOSED) plus the device-attestation gate for mobile
 * callers — the same App Attest mechanism /api/cheques/create uses.
 */
export async function POST(req: Request) {
  const guard = await guardGrowthRoute({
    req,
    route: "referral-capture",
    ip: REFERRAL_CAPTURE_IP,
  });
  if (!guard.ok) return guard.response;

  // Read the body ONCE as text: the App Attest assertion signs
  // SHA256(rawBody), so the gate needs the exact bytes the client hashed.
  const rawBody = await req.text();
  const attestBlock = await requireGrowthAttest(req, rawBody);
  if (attestBlock) return attestBlock;

  let body: { code?: string };
  try {
    // Parse the raw string we already read (an empty body still throws here,
    // so the 400 contract is unchanged from `await req.json()`).
    body = JSON.parse(rawBody) as { code?: string };
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
