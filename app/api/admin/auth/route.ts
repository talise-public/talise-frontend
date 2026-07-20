import { NextResponse } from "next/server";
import { ADMIN_COOKIE, adminToken, tokenMatches } from "@/lib/admin-auth";

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
