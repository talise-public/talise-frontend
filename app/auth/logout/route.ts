import { NextResponse } from "next/server";
import { clearSession } from "@/lib/session";
import { clearSigningCookie } from "@/lib/zksigner";

export const runtime = "nodejs";

/**
 * Tear down the web session. Clears the signed `talise_session` cookie
 * (lib/session.ts → clearSession) and the server-side signing cookie
 * (lib/zksigner.ts → clearSigningCookie) that stashes the JWT + salt.
 */
async function logout() {
  await clearSession();
  await clearSigningCookie();
}

// GET so a plain browser navigation to /auth/logout works (a logout LINK,
// not just a form POST). Without this a GET hits a POST-only handler and the
// browser shows "405 Method Not Allowed".
export async function GET(req: Request) {
  await logout();
  return NextResponse.redirect(new URL("/", req.url), { status: 303 });
}

// Kept for any code that POSTs to log out (e.g. a form/fetch with method POST).
export async function POST(req: Request) {
  await logout();
  return NextResponse.redirect(new URL("/", req.url), { status: 303 });
}
