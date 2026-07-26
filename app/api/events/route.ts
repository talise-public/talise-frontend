import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { getClientIp, rateLimitAsync } from "@/lib/rate-limit";
import { ingestBatch, type IngestContext } from "@/lib/analytics/growth-ingest";
import {
  GROWTH_PLATFORMS,
  MAX_EVENTS_PER_BATCH,
  type GrowthBatch,
  type GrowthEventInput,
  type GrowthPlatform,
} from "@/lib/analytics/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/events — the SINGLE product-analytics ingest endpoint.
 *
 * All three clients post here:
 *   • web     — web/lib/analytics/growth-browser.ts (fetch keepalive / sendBeacon)
 *   • iOS     — ios/Talise/Network/GrowthAnalytics.swift
 *   • Android — android/.../core/analytics/Growth.kt
 *
 * Design decisions worth knowing:
 *
 *   • ANONYMOUS-FRIENDLY. Authentication is optional: a landing-page visitor
 *     has no session, and `first_touch` / `invite_clicked` / `app_first_open`
 *     are exactly the events that must be recorded pre-signup. When a session
 *     or bearer IS present we resolve the user id server-side and the client's
 *     claim (if any) is ignored.
 *
 *   • NOT app-access gated. `denyUnlessAppApproved` guards value-moving
 *     endpoints; this endpoint moves nothing, and measuring the private-beta
 *     waiting room is one of the things we most need. Gating it would blind us
 *     to the top of the funnel.
 *
 *   • ALWAYS 204, never a body worth parsing, never an error a client should
 *     act on. A client must not retry-storm because analytics hiccuped, and a
 *     failed analytics write must never look like a failed action. Malformed
 *     or unknown events are dropped silently by the normalizer.
 *
 *   • The DB work happens AFTER the response (`after()` inside `ingestBatch`),
 *     so p99 here is JSON parse + auth resolve.
 */

/** Generous but finite: a client batches, so this is ~1 request per 10s of use.
 *  Keyed per user when authed, per IP otherwise. */
const RATE_LIMIT = 60;
const RATE_WINDOW_SEC = 60;

const PLATFORM_SET: ReadonlySet<string> = new Set(GROWTH_PLATFORMS);

/** 204 with no body. The only response this route ever gives. */
function accepted(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

export async function POST(req: Request) {
  // Resolve identity best-effort. An unauthenticated post is legitimate
  // (pre-signup funnel), so a failure here degrades to anonymous rather than
  // rejecting.
  const userId = await readEntryIdFromRequest(req).catch(() => null);

  const rl = await rateLimitAsync({
    key: userId ? `events:user:${userId}` : `events:ip:${getClientIp(req)}`,
    limit: RATE_LIMIT,
    windowSec: RATE_WINDOW_SEC,
  }).catch(() => ({ ok: true }));
  // Over the cap → drop on the floor, still 204. Telling a client to retry
  // analytics is worse than losing the sample.
  if (!rl.ok) return accepted();

  let body: GrowthBatch;
  try {
    body = (await req.json()) as GrowthBatch;
  } catch {
    return accepted();
  }
  const events: GrowthEventInput[] = Array.isArray(body?.events)
    ? body.events.slice(0, MAX_EVENTS_PER_BATCH)
    : [];
  if (!events.length) return accepted();

  const claimed = typeof body.platform === "string" ? body.platform : "";
  const platform: GrowthPlatform =
    PLATFORM_SET.has(claimed) && claimed !== "server" ? (claimed as GrowthPlatform) : "web";

  const ctx: IngestContext = {
    userId,
    // Coarse geo from the edge. We deliberately never read or store the IP
    // itself — `getClientIp` above is used only as a rate-limit key.
    country: req.headers.get("x-vercel-ip-country")?.slice(0, 2)?.toUpperCase() || null,
    receivedAt: Date.now(),
    anonId: typeof body.anonId === "string" ? body.anonId : null,
    sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
    platform,
    appVersion: typeof body.appVersion === "string" ? body.appVersion : null,
  };

  try {
    ingestBatch(events, ctx);
  } catch {
    /* never surface an analytics failure */
  }
  return accepted();
}
