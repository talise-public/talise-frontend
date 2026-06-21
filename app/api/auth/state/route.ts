import { NextResponse } from "next/server";
import { setStateCookie } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Receive an OAuth state token from the client and stash it in a signed
 * httpOnly cookie. The callback validates the returned state against this.
 */
export async function POST(req: Request) {
  let body: { state?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const state = body.state?.trim();
  if (!state || state.length < 8) {
    return NextResponse.json({ error: "bad state" }, { status: 400 });
  }
  await setStateCookie(state);
  return NextResponse.json({ ok: true });
}
