import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { setUserCountry } from "@/lib/db";

export const runtime = "nodejs";

/**
 * POST /api/me/country  { country: "NG" }
 *
 * Set ONLY the signed-in user's country (ISO alpha-2). Additive + idempotent —
 * used by the onboarding "Where are you?" step and a profile edit. Deliberately
 * does NOT set account_type (that's /api/onboarding's job, which 409s once set),
 * so this never interferes with account completion / the sign-up flow.
 */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  let body: { country?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const cc = String(body.country ?? "").toUpperCase().trim();
  if (!/^[A-Z]{2}$/.test(cc)) {
    return NextResponse.json({ error: "country must be ISO alpha-2" }, { status: 400 });
  }
  try {
    await setUserCountry(userId, cc);
    return NextResponse.json({ ok: true, country: cc });
  } catch {
    return NextResponse.json({ error: "update failed" }, { status: 500 });
  }
}
