import { NextResponse } from "next/server";
import { ADMIN_COOKIE, adminToken, tokenMatches } from "@/lib/admin-auth";
import { getClientIp, rateLimitAsync } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/auth  { token } → sets the httpOnly `talise_admin`
 * cookie when the token matches ADMIN_TOKEN. The dashboard gate reads
 * that cookie. 12h TTL.
 */
export async function POST(req: Request) {
  const expected = adminToken();
  if (!expected) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "ADMIN_TOKEN is not configured on the server. Set it in .env.local (or your deploy env) and restart.",
      },
      { status: 400 }
    );
  }

  // Brute-force guard. `tokenMatches` is constant-time, which defends against a
  // timing oracle but not against unlimited guessing: this route had no rate
  // limit and no lockout, so ADMIN_TOKEN was online-guessable at wire speed. A
  // hit grants a 12h cookie over /api/admin/raw (whole-table dumps of users and
  // KYC) and /api/admin/app-access (grants money access). Keyed on the
  // platform-resolved client IP, which `getClientIp` takes from the
  // non-spoofable x-vercel-forwarded-for when present.
  const ipRl = await rateLimitAsync({
    key: `admin-auth:ip:${getClientIp(req)}`,
    limit: 10,
    windowSec: 900,
  });
  if (!ipRl.ok) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(ipRl.retryAfterSec ?? 900) } }
    );
  }

  let body: { token?: unknown };
  try {
    body = (await req.json()) as { token?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : "";
  // Constant-time compare, a plain `!==` is a timing oracle that leaks
  // ADMIN_TOKEN byte-by-byte (F12). tokenMatches is length-guarded + CT.
  if (!tokenMatches(token)) {
    return NextResponse.json({ ok: false, error: "Invalid token." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, expected, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return res;
}

/** DELETE /api/admin/auth → clears the admin cookie (logout). */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
