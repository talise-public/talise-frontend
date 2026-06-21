import { NextResponse } from "next/server";
import {
  readEntryIdFromRequest,
  revokeAllMobileSessions,
  isMobileRequest,
} from "@/lib/mobile-sessions";
import { clearSession } from "@/lib/session";
import { clearSigningCookie } from "@/lib/zksigner";
import { userById, markUserDeleted } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/account/delete — in-app account deletion.
 *
 * Required by App Store Guideline 5.1.1(v): any app that supports account
 * creation must let the user initiate full account deletion from inside
 * the app. The iOS entry point is Profile → "Delete account".
 *
 * What it does (see markUserDeleted in lib/db.ts for the full contract):
 *   • Redacts the user row's PII (email / name / picture / business
 *     profile / country) and releases the @handle + Google-sub mapping,
 *     so the account can never be signed into again and a later sign-in
 *     with the same Google account starts fresh.
 *   • Hard-deletes PII side tables (linked bank accounts, push tokens,
 *     snapshots, savings goals).
 *   • Retains financial records (tx history, transfers, off-ramps, KYC /
 *     travel-rule artifacts) for bookkeeping and AML record-keeping.
 *   • Revokes every mobile bearer and clears the caller's web cookies.
 *
 * The wallet itself is self-custodial — deleting the Talise account does
 * NOT move funds. The iOS confirmation copy tells the user to withdraw
 * first; the same Google identity re-derives the same zkLogin address, so
 * on-chain funds remain reachable even after deletion.
 *
 * Deliberately NOT gated by the private-beta app-access allowlist:
 * deletion must work for every account that exists, approved or not.
 */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    // Unknown OR already deleted — both are a success from the client's
    // point of view (the account is gone). Keep it idempotent.
    return NextResponse.json({ ok: true, alreadyDeleted: true });
  }

  await markUserDeleted(userId);

  // Kill sessions: every mobile bearer for this user, plus the calling
  // browser's cookies on the web path. (Other browsers' cookies die at
  // the userById chokepoint — deleted rows resolve to null.)
  await revokeAllMobileSessions(userId);
  if (!isMobileRequest(req)) {
    await clearSession();
    await clearSigningCookie();
  }

  return NextResponse.json({ ok: true });
}
