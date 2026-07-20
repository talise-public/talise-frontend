import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-auth";
import { grantAppAccess, revokeAppAccess, listAppAccess } from "@/lib/db";

export const runtime = "nodejs";

/**
 * ADMIN, manage the private-beta app allowlist (/app + /business gate).
 *
 *   GET  /api/admin/app-access                  → { entries: [...] }
 *   POST /api/admin/app-access                  → grant / revoke
 *        { email: "a@b.com", grant: true,  note?: "wave 1" }
 *        { emails: ["a@b.com", ...], grant: true }   (bulk)
 *        { email: "a@b.com", grant: false }          (revoke)
 *
 * Auth: admin session cookie or `x-admin-token` header (requireAdminApi).
 */
export async function GET(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;
  const entries = await listAppAccess();
  return NextResponse.json({ entries });
}

export async function POST(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;

  let body: { email?: string; emails?: string[]; grant?: boolean; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const emails = (body.emails ?? (body.email ? [body.email] : []))
    .map((e) => String(e).trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (emails.length === 0) {
    return NextResponse.json({ error: "no valid emails" }, { status: 400 });
  }
  const grant = body.grant !== false;

  for (const email of emails) {
    if (grant) await grantAppAccess(email, "admin", body.note);
    else await revokeAppAccess(email);
  }
  return NextResponse.json({ ok: true, count: emails.length, granted: grant });
}
