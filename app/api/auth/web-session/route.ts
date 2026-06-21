import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { setSessionCookie } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/web-session
 *
 * Bearer → web-session bridge for the iOS in-app web layer. The native app
 * authenticates with a mobile Bearer token, but web PAGES (e.g. /private) gate
 * on the `talise_session` httpOnly cookie. So the in-app WKWebView loads THIS
 * url with `Authorization: Bearer <token>` on the top-level request; we verify
 * the bearer, mint the matching web-session cookie, and 302 to the in-app page.
 * The WKWebView follows the redirect WITH the cookie set, so the page + its
 * same-origin shield API calls are authenticated — keeping the private flow
 * fully inside the app (no Safari hand-off).
 *
 * Anti-open-redirect: the destination is restricted to a fixed allowlist of
 * internal app paths; anything else falls back to /private.
 */
const ALLOWED_NEXT = new Set(["/private", "/shield-prove"]);

export async function GET(req: Request) {
  const entryId = await readEntryIdFromRequest(req);
  if (!entryId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const requested = url.searchParams.get("next") ?? "/private";
  const next = ALLOWED_NEXT.has(requested) ? requested : "/private";

  // Mint the web-session cookie for this verified mobile identity, then bounce
  // to the in-app page. The cookie is attached to the redirect response.
  await setSessionCookie(entryId);
  return NextResponse.redirect(new URL(next, url.origin), { status: 302 });
}
