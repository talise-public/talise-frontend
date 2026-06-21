import { NextResponse } from "next/server";
import { setReturnTo, safeReturnPath } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { returnTo?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  // Reject anything that isn't a strict same-origin path. `startsWith("/")`
  // alone would let protocol-relative `//evil.com` through → open redirect
  // after sign-in. `safeReturnPath` blocks `//`, `/\`, backslashes, and
  // control chars. (setReturnTo re-validates too — fail loudly here.)
  const path = safeReturnPath((body.returnTo ?? "").trim());
  if (!path) {
    return NextResponse.json({ error: "must be a same-origin path" }, { status: 400 });
  }
  await setReturnTo(path);
  return NextResponse.json({ ok: true });
}
