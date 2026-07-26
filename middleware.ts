import { NextResponse, type NextRequest } from "next/server";
import { abuseLog } from "@/lib/abuse/log";
import {
  classifyIp,
  clientIpFromHeaders,
  ipReputationStats,
} from "@/lib/abuse/ip-reputation";
import { REWARDS_REDEEM_IP } from "@/lib/abuse/limits";
import { upstashFixedWindow } from "@/lib/rate-limit";

/**
 * Global security response headers.
 *
 * Applied to every path — runs at the edge before the route handler so
 * the headers are present even on cached or static responses.
 *
 * CSP: shipped in REPORT-ONLY mode (2026-06-01). A strict enforcing CSP can
 * break product flows (inline-styled emails, third-party onramp/offramp
 * iframes, Next.js inline bootstrap), so we monitor first: violations are
 * reported but nothing is blocked. PROMOTE to enforcing (rename the header to
 * `Content-Security-Policy` + switch script-src to a per-request nonce instead
 * of 'unsafe-inline') once the Vercel/console reports confirm zero legitimate
 * violations. Until then this still hardens against the worst case alongside
 * the session-only ephemeral-key storage (web/lib/zkclient.ts).
 */
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self' https://accounts.google.com",
  // 'unsafe-inline' is a temporary allowance for Next's inline bootstrap +
  // Vercel Analytics; replace with a nonce when promoting to enforcing.
  "script-src 'self' 'unsafe-inline' https://va.vercel-scripts.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://lh3.googleusercontent.com https://images.unsplash.com",
  "font-src 'self' data:",
  "connect-src 'self' https://accounts.google.com https://*.vercel-insights.com https://va.vercel-scripts.com",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  // Monitor-only CSP (see note above) — defense-in-depth against XSS without
  // risking a broken product flow before launch.
  "Content-Security-Policy-Report-Only": CSP_REPORT_ONLY,
  // Two-year HSTS with preload — matches the chrome://hsts requirement.
  // Safe because every Talise host already serves HTTPS exclusively.
  "Strict-Transport-Security":
    "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Disable powerful APIs we never request. Tighten further when we add
  // payments / clipboard APIs and need explicit grants.
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// F13: cap request bodies on the API surface. Next.js App Router doesn't
// impose a small default, so a multi-MB/GB POST is a cheap allocation/parse
// DoS. 1 MB is far above any legitimate Talise payload (signable bytes are
// tens of KB; webhooks are small). Chunked/absent Content-Length falls
// through to the route's own parse — no regression.
const MAX_API_BODY_BYTES = 1_048_576;

/**
 * Host-based routing — the wallet lives on its own subdomain.
 *
 *   app.talise.io/…      → internally REWRITTEN onto the /app tree, so the
 *                          subdomain serves the product at its root
 *                          (app.talise.io/ramps → /app/ramps). Paths that are
 *                          real top-level trees (api, auth, _next, the public
 *                          receive surfaces, /app itself) pass through so
 *                          in-app links (`/app/pay`) and OAuth keep working.
 *   talise.io/app/…      → 308 to app.talise.io/… (the marketing domain no
 *   www.talise.io/app/…    longer serves the product; one canonical app host).
 *
 * Auth works across hosts because every auth cookie is issued with
 * Domain=.talise.io (COOKIE_DOMAIN env — see lib/session.ts): Google's
 * callback still lands on www, and the session it mints is readable on app.
 */
const APP_HOST = "app.talise.io";
const PERPS_HOST = "perps.talise.io";
const MARKETING_HOSTS = new Set(["talise.io", "www.talise.io"]);

function withSecurityHeaders(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(k, v);
  }
  return res;
}

// ── IP denylist (2026-06-07, generalised 2026-07-24) ─────────────────
// Hard-block abusive sources at the edge, before any route runs. The two
// Tencent Cloud IPs that flooded the waitlist sign-up used to be inline
// literals here; they now live in lib/abuse/ip-reputation.ts alongside CIDR
// support, a curated datacenter/VPS range list, and the env overrides
// (BLOCKED_IPS — still exact IPs, now also CIDRs — plus BLOCKED_CIDRS).
// Same behaviour as before at the edge: a hard-denied IP gets 403 on every
// path. Matching uses the same non-spoofable client-IP resolution the rate
// limiter uses (Vercel-set headers first).

// ── Country geo-block (2026-06-07) ───────────────────────────────────
// Block whole countries at the edge using Vercel's geo tag
// (`x-vercel-ip-country`, set by the edge on every request — not present
// in local dev, so dev is never blocked). Seeded with ID (Indonesia);
// extend/adjust without a code change via the BLOCKED_COUNTRIES env var
// (comma-separated ISO-3166 alpha-2 codes). Best-effort: a VPN/proxy in
// another country evades it, the same as any geo-fence.
const BLOCKED_COUNTRIES: ReadonlySet<string> = new Set(
  [
    "ID",
    ...(process.env.BLOCKED_COUNTRIES ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  ]
);

// Log the denylist size once per instance so a prod boot log proves the
// list actually loaded (a typo'd BLOCKED_IPS silently blocking nothing is
// exactly the failure we can't see otherwise).
let repStatsLogged = false;
function logIpReputationOnce(): void {
  if (repStatsLogged) return;
  repStatsLogged = true;
  const s = ipReputationStats();
  console.info(
    `[abuse] event=boot hard_deny=${s.hardDeny} datacenter_ranges=${s.datacenter}`
  );
}

/**
 * Edge rate limit for POST /api/rewards/redeem.
 *
 * The route handler itself is not ours to edit, and points redemption was
 * completely unmetered, so the limit is applied here at the edge instead.
 * Two consequences, both deliberate:
 *   • Per-IP only. The session cookie is signed and verifying it needs the
 *     node runtime (crypto + DB), which the edge doesn't have.
 *   • Upstash-or-nothing. There is no Postgres at the edge, so when Upstash
 *     is unconfigured this check FAILS OPEN (it cannot count). That's the
 *     one place on the growth surface that still fails open; moving the
 *     guard into the route file (durable + fail-closed + per-user) is the
 *     follow-up once that file's owner lands their changes.
 */
async function limitRewardsRedeem(
  req: NextRequest,
  ip: string
): Promise<NextResponse | null> {
  try {
    const rl = await upstashFixedWindow({
      key: `abuse:rewards-redeem:ip:${ip}:w${REWARDS_REDEEM_IP.windowSec}`,
      limit: REWARDS_REDEEM_IP.limit,
      windowSec: REWARDS_REDEEM_IP.windowSec,
    });
    if (!rl) return null; // Upstash unset → cannot count, see note above.
    if (rl.ok) return null;
    const retryAfterSec = rl.retryAfterSec ?? REWARDS_REDEEM_IP.windowSec;
    abuseLog("rate_limited", {
      route: "rewards-redeem",
      scope: "ip",
      ip,
      limit: REWARDS_REDEEM_IP.limit,
      window: REWARDS_REDEEM_IP.windowSec,
      backend: "upstash",
      edge: true,
      retry_after: retryAfterSec,
    });
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly.", code: "RATE_LIMITED" },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfterSec),
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (err) {
    // Redis error at the edge: allow (a redemption must not 500 on a Redis
    // hiccup) but make the degradation visible.
    abuseLog("fail_closed", {
      route: "rewards-redeem",
      backend: "upstash",
      stage: "degraded",
      edge: true,
      err: (err as Error).message,
    });
    return null;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  logIpReputationOnce();
  // Edge-level ban: denylisted IPs get 403 on EVERY path before any route
  // or DB touch. Cheapest possible place to shed abusive traffic.
  const ip = clientIpFromHeaders(req.headers);
  const rep = classifyIp(ip);
  if (rep.hardDenied) {
    abuseLog("ip_denied", {
      route: pathname,
      ip,
      rule: rep.deniedBy?.cidr,
      org: rep.deniedBy?.org,
      edge: true,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Geo-block: visitors from a blocked country get a 451 with a short
  // human-readable page (browsers hit pages, not JSON). The country comes
  // from Vercel's edge tag; absent in local dev so dev is never blocked.
  const country = req.headers.get("x-vercel-ip-country")?.toUpperCase();
  if (country && BLOCKED_COUNTRIES.has(country)) {
    return new NextResponse(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>Talise — not available in your region</title>` +
        `<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;` +
        `justify-content:center;background:#fafdf8;color:#14250e;` +
        `font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}` +
        `main{max-width:420px;padding:32px;text-align:center}` +
        `h1{font-size:22px;margin:0 0 10px;letter-spacing:-.02em}` +
        `p{font-size:15px;line-height:1.5;color:#586b50;margin:0}</style></head>` +
        `<body><main><h1>Talise isn't available in your region yet</h1>` +
        `<p>We're not accepting visitors from your location at this time. ` +
        `Follow <a href="https://x.com/taliseio" style="color:#2f7d31">@taliseio</a> for updates.</p>` +
        `</main></body></html>`,
      {
        status: 451,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      }
    );
  }

  if (
    pathname.startsWith("/api/") &&
    (req.method === "POST" || req.method === "PUT" || req.method === "PATCH")
  ) {
    const len = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(len) && len > MAX_API_BODY_BYTES) {
      return NextResponse.json({ error: "payload too large" }, { status: 413 });
    }
  }

  // Points redemption: the only growth route whose handler is out of reach
  // (another owner), so its limit lives here. Checked after the free
  // static gates (denylist, geo, body size) so we only pay the Redis
  // round-trip on requests that are otherwise going to be served.
  if (req.method === "POST" && pathname.startsWith("/api/rewards/redeem")) {
    const denied = await limitRewardsRedeem(req, ip);
    if (denied) return denied;
  }

  const host = (req.headers.get("host") ?? "").toLowerCase().split(":")[0];

  // perps.talise.io → the dedicated Perps terminal. Serve the /perps route tree
  // at the subdomain root; the backend (api/auth/assets) and public money links
  // keep serving so sign-in + trading work. A stray /app link on this host bounces
  // to the wallet host. Auth cookies are Domain=.talise.io, so the session that
  // signs in here is the same one the wallet uses.
  if (host === PERPS_HOST) {
    const keepAlive = /^\/(api|auth|shield|c|i|u|pay|req|admin|_next|_vercel)(\/|$)/;
    if (keepAlive.test(pathname)) {
      return withSecurityHeaders(NextResponse.next());
    }
    if (pathname === "/app" || pathname.startsWith("/app/")) {
      return withSecurityHeaders(NextResponse.redirect(`https://${APP_HOST}${pathname === "/app" ? "/" : pathname.slice(4)}`, 307));
    }
    if (!pathname.startsWith("/perps")) {
      const url = req.nextUrl.clone();
      url.pathname = pathname === "/" ? "/perps" : `/perps${pathname}`;
      return withSecurityHeaders(NextResponse.rewrite(url));
    }
    return withSecurityHeaders(NextResponse.next());
  }

  // app.talise.io → the web wallet is retired; everyone goes to the iOS beta.
  // Backend stays fully alive so nothing breaks: the iOS app's API (`/api`),
  // OAuth (`/auth`), the shield prover assets (`/shield`), public money links
  // (`/c` `/i` `/u` `/pay` `/req`), ops (`/admin`), and framework assets
  // (`/_next` `/_vercel`) all keep serving. Every other path (the wallet UI,
  // `/app`, `/business`, the bare root) redirects to TestFlight.
  if (host === APP_HOST) {
    // The private-send prover harness (`/shield-prove`) must keep serving: it
    // is the headless engine behind in-app private sends, loaded in a hidden
    // WKWebView via /api/auth/web-session?next=/shield-prove. It lives on the
    // /app route tree, so rewrite the clean path onto it and SERVE it. (The
    // web-wallet retirement removed the old blanket /app rewrite, so without
    // this the page fell through to the TestFlight redirect below — which
    // silently broke every private send: the webview landed on TestFlight, the
    // harness never installed, and the native send threw "not ready". The
    // user-facing /private page stays retired on purpose.) Keep this ABOVE the
    // keep-alive/redirect. The harness still requires the web-session cookie
    // (only minted from a verified mobile bearer), so this exposes nothing new.
    if (pathname === "/shield-prove") {
      const url = req.nextUrl.clone();
      url.pathname = "/app/shield-prove";
      return withSecurityHeaders(NextResponse.rewrite(url));
    }
    // Perps lives on its own canonical host. Any /perps link on the wallet host
    // (the "trade perps" banner, a shared/bookmarked link, direct navigation)
    // bounces to perps.talise.io so the terminal always runs under its own
    // subdomain — never app.talise.io/perps. Subpaths map to the clean root
    // (/perps → /, /perps/x → /x), matching the URLs the perps host serves.
    if (pathname === "/perps" || pathname.startsWith("/perps/")) {
      const rest = pathname.slice("/perps".length) || "/";
      return withSecurityHeaders(
        NextResponse.redirect(`https://${PERPS_HOST}${rest}${req.nextUrl.search}`, 307),
      );
    }
    const keepAlive = /^\/(api|auth|shield|c|i|u|pay|req|admin|_next|_vercel)(\/|$)/;
    if (keepAlive.test(pathname)) {
      return withSecurityHeaders(NextResponse.next());
    }
    // Web wallet is OPEN: serve the /app tree on app.talise.io so users can use
    // the web app (the UI already gates sign-in + waiting room itself). Reverse
    // it with WEB_APP_OPEN=false to retire back to the iOS-only TestFlight
    // redirect. The iOS backend (keep-alive paths above) is unaffected either way.
    if (process.env.WEB_APP_OPEN === "false") {
      return NextResponse.redirect(
        "https://testflight.apple.com/join/BFNEPYtM",
        307
      );
    }
    // The app's pages live under the /app route tree and its nav uses /app/*
    // hrefs. Map the bare host root + any non-/app clean path onto that tree.
    if (!pathname.startsWith("/app")) {
      const url = req.nextUrl.clone();
      url.pathname = pathname === "/" ? "/app" : `/app${pathname}`;
      return withSecurityHeaders(NextResponse.rewrite(url));
    }
    return withSecurityHeaders(NextResponse.next());
  }

  // talise.io/app/* → the canonical app host. Subpaths KEEP the /app prefix
  // (the /app tree passes through on the subdomain, and stripping it would
  // collide with the public top-level trees: /app/pay ≠ /pay/[handle]).
  // Only the bare /app drops it for the clean app.talise.io/ entry.
  if (
    MARKETING_HOSTS.has(host) &&
    (pathname === "/app" || pathname.startsWith("/app/"))
  ) {
    const url = req.nextUrl.clone();
    url.protocol = "https:";
    url.host = APP_HOST;
    url.port = "";
    url.pathname = pathname === "/app" ? "/" : pathname;
    return withSecurityHeaders(NextResponse.redirect(url, 308));
  }

  // Note: we deliberately do NOT redirect www→apex here. The Vercel
  // project's primary domain is www.talise.io and Vercel already 307s
  // the apex over to www. A second redirect in the opposite direction
  // creates a loop and (worse) turns API POSTs into GETs the moment
  // the browser follows the redirect — breaking the waitlist form. The
  // OAuth redirect_uri mismatch is solved on the Google Cloud Console
  // side instead by registering both variants.
  return withSecurityHeaders(NextResponse.next());
}

export const config = {
  // Skip Next internals + common static assets — those don't need the
  // headers and adding them on every static fetch is wasted work. We
  // keep the matcher liberal otherwise so every page + API response
  // picks the headers up.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf|eot)).*)",
  ],
};
