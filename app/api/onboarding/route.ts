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

export async function POST(req: Request) {
  const id = await readEntryIdFromRequest(req);
  if (!id) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const user = await userById(id);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  if (user.account_type) {
    return NextResponse.json(
      { error: "account type already set" },
      { status: 409 }
    );
  }

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
    body = await req.json();
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
