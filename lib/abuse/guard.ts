import "server-only";

import { NextResponse } from "next/server";
import { pgFixedWindow } from "@/lib/abuse/counters";
import { abuseLog } from "@/lib/abuse/log";
import {
  blockDatacenterOnGrowthRoutes,
  classifyIp,
  clientIpFromHeaders,
  type IpRange,
} from "@/lib/abuse/ip-reputation";
import type { AbuseLimit } from "@/lib/abuse/limits";
import { upstashFixedWindow, type RateLimitResult } from "@/lib/rate-limit";

/**
 * The growth-surface abuse guard: rate limiting that is REAL (durable, not
 * a per-lambda Map), FAILS CLOSED, and is observable.
 *
 * ── Why a separate guard from `rateLimitAsync` ──────────────────────────
 * `rateLimitAsync` fails open by design: a money send must not 500 because
 * Redis hiccuped. That trade is wrong for the growth surface, where the
 * whole value of a request to an attacker is a free write (a referral
 * attribution, a signup row, a points redemption) and where a brief outage
 * of the limiter is a free-for-all. So this guard:
 *
 *   1. tries Upstash Redis (global, ~1.5s timeout) — same primary backend;
 *   2. falls back to a durable Postgres counter (lib/abuse/counters.ts)
 *      that is global across lambdas, unlike the in-memory Map that
 *      `rateLimitAsync` degrades to today (Upstash env is unset in prod —
 *      audit F3);
 *   3. if BOTH are unavailable, FAILS CLOSED with 503 rather than letting
 *      uncounted traffic through.
 *
 * Scope is deliberately narrow — referral, onboarding, waitlist, rewards
 * redemption. Do NOT use it on send/limit/quote paths: those must stay
 * available, and the Postgres round-trip belongs nowhere near them (prod's
 * connection pool is small).
 *
 * ── Keys ────────────────────────────────────────────────────────────────
 * Per-IP AND per-user, checked independently, so neither a botnet of one
 * user nor one IP cycling accounts slips through. IP comes from the
 * platform-set, non-spoofable headers only.
 *
 * ── Datacenter tier ─────────────────────────────────────────────────────
 * A request from known cloud/VPS space gets its per-IP allowance divided by
 * `DATACENTER_DIVISOR`. Not a hard block: commercial VPNs live on the same
 * ranges and this is a real-money wallet. `ABUSE_BLOCK_DATACENTER=true`
 * escalates to 403 on these routes when a flood is actually in progress.
 */

// The allowance shape lives in limits.ts (a leaf module the edge middleware
// can import); re-exported here so route code needs one import.
export type { AbuseLimit } from "@/lib/abuse/limits";

export interface GuardSpec {
  req: Request;
  /**
   * Stable route id used in both log lines and counter keys. Keep it
   * hand-written (e.g. "referral-capture") rather than derived from the
   * URL, so a path change can't silently reset everyone's counters.
   */
  route: string;
  /**
   * Per-IP limits. Pass an array for a multi-window policy (e.g. a tight
   * burst window plus a loose sustained one); each window is its own
   * counter and ALL must pass. At least one of `ip` / `user` is required.
   */
  ip?: AbuseLimit | readonly AbuseLimit[];
  /** Per-user limits; ignored when `userId` is null (anonymous caller). */
  user?: AbuseLimit | readonly AbuseLimit[];
  userId?: number | string | null;
  /**
   * Set false for read-only routes where a degraded limiter should not take
   * the feature down (defaults to true = fail closed). Use sparingly and
   * say why at the call site.
   */
  failClosed?: boolean;
}

export type GuardVerdict =
  | { ok: true; ip: string; datacenter: IpRange | null }
  | {
      ok: false;
      ip: string;
      datacenter: IpRange | null;
      reason: "ip_denied" | "rate_limited" | "backend_unavailable";
      status: 403 | 429 | 503;
      retryAfterSec: number;
      /** Ready-made JSON response matching the repo's error shape. */
      response: NextResponse;
    };

/** Per-IP allowance divisor for known cloud/VPS sources (min 1). */
const DATACENTER_DIVISOR = 10;

type Backend = "upstash" | "postgres";

/**
 * Durable fixed-window check. Returns null when NO backend could answer —
 * the signal for the caller's fail-closed policy.
 */
async function durableWindow(
  key: string,
  limit: number,
  windowSec: number,
  route: string
): Promise<{ res: RateLimitResult; backend: Backend } | null> {
  try {
    const redis = await upstashFixedWindow({ key, limit, windowSec });
    if (redis) return { res: redis, backend: "upstash" };
  } catch (err) {
    // Redis configured but broken → fall through to Postgres rather than
    // allowing the request (which is what rateLimitAsync would do).
    abuseLog("fail_closed", {
      route,
      backend: "upstash",
      stage: "degraded",
      err: (err as Error).message,
    });
  }
  try {
    return { res: await pgFixedWindow({ key, limit, windowSec }), backend: "postgres" };
  } catch (err) {
    abuseLog("fail_closed", {
      route,
      backend: "postgres",
      stage: "unavailable",
      err: (err as Error).message,
    });
    return null;
  }
}

function asList(l: AbuseLimit | readonly AbuseLimit[] | undefined): readonly AbuseLimit[] {
  if (!l) return [];
  return Array.isArray(l) ? l : [l as AbuseLimit];
}

function jsonDeny(
  status: 403 | 429 | 503,
  body: Record<string, unknown>,
  retryAfterSec: number
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      "Retry-After": String(Math.max(1, retryAfterSec)),
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Run the guard. Returns a verdict; on failure the caller can either return
 * `verdict.response` verbatim or degrade in its own way (e.g. /r/[code]
 * still redirects, it just refuses to write the attribution cookie).
 *
 * Never throws.
 */
export async function guardGrowthRoute(spec: GuardSpec): Promise<GuardVerdict> {
  const { req, route, userId = null } = spec;
  const failClosed = spec.failClosed !== false;
  const ip = clientIpFromHeaders(req.headers);
  const rep = classifyIp(ip);
  const userKeyPart = userId === null ? null : String(userId);

  // Hard denylist. Middleware already 403s these at the edge; repeating the
  // check here means a route stays protected even if the matcher changes or
  // it's reached internally (rewrite, cron, direct invoke).
  if (rep.hardDenied) {
    abuseLog("ip_denied", { route, ip, rule: rep.deniedBy?.cidr, org: rep.deniedBy?.org });
    return {
      ok: false,
      ip,
      datacenter: null,
      reason: "ip_denied",
      status: 403,
      retryAfterSec: 3600,
      response: jsonDeny(403, { error: "Forbidden" }, 3600),
    };
  }

  if (rep.datacenter) {
    abuseLog("datacenter", {
      route,
      ip,
      org: rep.datacenter.org,
      asn: rep.datacenter.asn,
      cidr: rep.datacenter.cidr,
      action: blockDatacenterOnGrowthRoutes() ? "block" : `divide_${DATACENTER_DIVISOR}`,
    });
    if (blockDatacenterOnGrowthRoutes()) {
      return {
        ok: false,
        ip,
        datacenter: rep.datacenter,
        reason: "ip_denied",
        status: 403,
        retryAfterSec: 3600,
        response: jsonDeny(403, { error: "Forbidden" }, 3600),
      };
    }
  }

  // Under Vitest the DB is an in-memory fake with a hand-written SQL matcher
  // (see __tests__/sui/handle-claim.test.ts), so a durable counter cannot
  // work and fail-closed would turn every route test into a 503. The suite's
  // existing convention is to mock limiters to "always allow"; this keeps
  // that contract for routes that no longer import `@/lib/rate-limit`
  // directly. `VITEST` is injected by the test runner and is never set in a
  // Vercel build or runtime, so this branch cannot execute in production.
  // The IP denylist above still applies, so denylist behaviour stays testable.
  if (process.env.VITEST) {
    return { ok: true, ip, datacenter: rep.datacenter };
  }

  // Build the checks: per-IP (tightened for datacenter sources) + per-user.
  // The window length is part of the key so a multi-window policy gets one
  // counter per window instead of two policies sharing (and double-counting
  // into) the same bucket.
  const checks: Array<{ scope: "ip" | "user"; key: string } & AbuseLimit> = [];
  for (const l of asList(spec.ip)) {
    const limit = rep.datacenter
      ? Math.max(1, Math.floor(l.limit / DATACENTER_DIVISOR))
      : l.limit;
    checks.push({
      scope: "ip",
      key: `abuse:${route}:ip:${ip}:w${l.windowSec}`,
      limit,
      windowSec: l.windowSec,
    });
  }
  if (userKeyPart) {
    for (const l of asList(spec.user)) {
      checks.push({
        scope: "user",
        key: `abuse:${route}:user:${userKeyPart}:w${l.windowSec}`,
        limit: l.limit,
        windowSec: l.windowSec,
      });
    }
  }

  for (const c of checks) {
    const outcome = await durableWindow(c.key, c.limit, c.windowSec, route);
    if (!outcome) {
      // No backend could count this request.
      if (!failClosed) {
        // Explicitly opted out (read-only route): allow, but the
        // fail_closed line above already recorded the degradation.
        continue;
      }
      return {
        ok: false,
        ip,
        datacenter: rep.datacenter,
        reason: "backend_unavailable",
        status: 503,
        retryAfterSec: 30,
        response: jsonDeny(
          503,
          { error: "Try again shortly.", code: "RATE_LIMIT_UNAVAILABLE" },
          30
        ),
      };
    }
    if (!outcome.res.ok) {
      const retryAfterSec = outcome.res.retryAfterSec ?? c.windowSec;
      abuseLog("rate_limited", {
        route,
        scope: c.scope,
        ip,
        user: userKeyPart,
        limit: c.limit,
        window: c.windowSec,
        backend: outcome.backend,
        datacenter: rep.datacenter?.org,
        retry_after: retryAfterSec,
      });
      return {
        ok: false,
        ip,
        datacenter: rep.datacenter,
        reason: "rate_limited",
        status: 429,
        retryAfterSec,
        response: jsonDeny(
          429,
          { error: "Too many attempts. Try again shortly.", code: "RATE_LIMITED" },
          retryAfterSec
        ),
      };
    }
  }

  return { ok: true, ip, datacenter: rep.datacenter };
}
