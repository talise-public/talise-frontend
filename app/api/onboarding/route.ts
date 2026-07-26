import { NextResponse } from "next/server";
import {
  clearReferralCookie,
  readReferralCookie,
} from "@/lib/session";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import {
  attributeReferral,
  isHandleTaken,
  REFERRAL_CODE_RE,
  setAccountType,
  userById,
} from "@/lib/db";
import { POINTS } from "@/lib/rewards";
import { requireGrowthAttest } from "@/lib/abuse/attest";
import { guardGrowthRoute } from "@/lib/abuse/guard";
import { ONBOARDING_IP, ONBOARDING_USER } from "@/lib/abuse/limits";

export const runtime = "nodejs";

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Attribute a referral if a code was provided either explicitly in the body
 * or implicitly via the `talise_ref` cookie. Always clears the cookie when
 * we attempted attribution so we don't try again next time. Failures are
 * silent, onboarding completes regardless.
 */
async function tryAttributeReferral(
  newUserId: number,
  explicitCode: string | null
): Promise<void> {
  const cookieCode = await readReferralCookie();
  const code = (explicitCode ?? cookieCode ?? "").trim().toUpperCase();
  if (!REFERRAL_CODE_RE.test(code)) {
    if (cookieCode) await clearReferralCookie();
    return;
  }
  try {
    await attributeReferral(newUserId, code, {
      referrer: POINTS.REFERRAL_SIGNUP_REFERRER,
      referee: POINTS.REFERRAL_SIGNUP_REFEREE,
    });
  } catch {
    /* non-blocking */
  }
  await clearReferralCookie();
}

/**
 * POST /api/onboarding
 *
 * ABUSE (2026-07-24): this is where a referral actually pays out — it calls
 * `attributeReferral`, which credits BOTH sides with points. It had no rate
 * limit, no IP check and no device gate, so a farm of fresh zkLogin accounts
 * could mint referral points as fast as it could sign in. Now:
 *   • durable per-user + per-IP limits (fail closed, global across lambdas);
 *   • App Attest for mobile callers, the same gate /api/cheques/create uses,
 *     so scripted signups can't come from a non-device client.
 * The one-shot `account_type` 409 below is still the real cap on repeat
 * attribution for a single account; these limits cap the ACCOUNT FARM.
 */
export async function POST(req: Request) {
  const id = await readEntryIdFromRequest(req);
  if (!id) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const guard = await guardGrowthRoute({
    req,
    route: "onboarding",
    userId: id,
    ip: ONBOARDING_IP,
    user: ONBOARDING_USER,
  });
  if (!guard.ok) return guard.response;

  const user = await userById(id);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  if (user.account_type) {
    return NextResponse.json(
      { error: "account type already set" },
      { status: 409 }
    );
  }

  // Raw body first: the App Attest assertion signs SHA256(rawBody), so the
  // gate must see the exact bytes the client hashed (re-serialising a parsed
  // object would not match).
  const rawBody = await req.text();
  const attestBlock = await requireGrowthAttest(req, rawBody);
  if (attestBlock) return attestBlock;

  let body: {
    accountType?: string;
    businessName?: string;
    businessHandle?: string;
    businessIndustry?: string | null;
    interests?: string[];
    country?: string | null;
    notify?: boolean;
    referralCode?: string | null;
  };
  try {
    // Parse the raw string we already read (an empty body still throws here,
    // so the 400 contract is unchanged from `await req.json()`).
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  if (body.accountType === "personal") {
    await setAccountType(id, {
      accountType: "personal",
      interests: Array.isArray(body.interests) ? body.interests : null,
      country: body.country ?? null,
      notifyOnReceive: !!body.notify,
    });
    await tryAttributeReferral(id, body.referralCode ?? null);
    return NextResponse.json({ ok: true, redirect: "/app" });
  }

  if (body.accountType === "business") {
    const name = (body.businessName ?? "").trim();
    const handle = (body.businessHandle ?? "").trim().toLowerCase();
    if (name.length < 2) {
      return NextResponse.json({ error: "business name too short" }, { status: 400 });
    }
    if (!HANDLE_RE.test(handle)) {
      return NextResponse.json(
        { error: "handle must be 2-32 chars of a-z, 0-9, hyphen" },
        { status: 400 }
      );
    }
    if (await isHandleTaken(handle)) {
      return NextResponse.json({ error: "handle is taken" }, { status: 409 });
    }
    await setAccountType(id, {
      accountType: "business",
      businessName: name,
      businessHandle: handle,
      businessIndustry: body.businessIndustry || null,
      country: body.country ?? null,
      notifyOnReceive: true,
    });
    await tryAttributeReferral(id, body.referralCode ?? null);
    return NextResponse.json({ ok: true, redirect: "/business/dashboard" });
  }

  return NextResponse.json({ error: "unknown account type" }, { status: 400 });
}
