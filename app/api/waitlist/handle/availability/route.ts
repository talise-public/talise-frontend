import { NextResponse } from "next/server";
import { ensureSchema } from "@/lib/db";
import {
  isWaitlistHandleAvailable,
  normalizeReasonMessage,
  normalizeWaitlistHandle,
} from "@/lib/handle-claim";
import { guardGrowthRoute } from "@/lib/abuse/guard";
import { WAITLIST_AVAILABILITY_IP } from "@/lib/abuse/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/waitlist/handle/availability
 *
 * Body: { handle: string }   (any `email` field is ignored, see below)
 *
 * Returns:
 *   200 { available: true,  normalized: "alice" }
 *   200 { available: false, reason: "taken_db" | "taken_chain", normalized }
 *   400 { error: <message> }      – invalid handle
 *
 * ANTI-ENUMERATION: this endpoint reports ONLY whether a handle is free.
 * It deliberately does NOT accept an email or report anything about
 * waitlist/claim status for any email, so it can't be used to test
 * "is this email on the waitlist / has it claimed". The frontend learns
 * the caller's own already-claimed state from `/api/auth/me` instead.
 *
 * Rate-limited per IP with a tight burst limit on top of the per-minute
 * cap, the live-availability UI calls this on every (debounced)
 * keystroke, but a scripted enumerator scraping the taken-handle space
 * trips the burst limit fast.
 *
 * Both windows moved to the durable growth guard (2026-07-24): they are now
 * GLOBAL across lambdas and fail CLOSED. Under `rateLimitAsync` with Upstash
 * unset the real cap was N_instances × 30, which for a namespace scan is no
 * cap at all — a scraper just needed to be spread across warm instances. See
 * lib/abuse/limits.ts for the numbers and why the per-minute window got
 * looser as the enforcement got real.
 */

export async function POST(req: Request) {
  const guard = await guardGrowthRoute({
    req,
    route: "waitlist-availability",
    ip: WAITLIST_AVAILABILITY_IP,
  });
  if (!guard.ok) return guard.response;

  let body: { handle?: unknown };
  try {
    body = (await req.json()) as { handle?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const norm = normalizeWaitlistHandle(body.handle);
  if (!norm.ok) {
    return NextResponse.json(
      { error: normalizeReasonMessage(norm.reason), reason: norm.reason },
      { status: 400 }
    );
  }

  try {
    await ensureSchema();

    const verdict = await isWaitlistHandleAvailable(norm.handle);
    if (verdict.available) {
      return NextResponse.json({ available: true, normalized: norm.handle });
    }
    return NextResponse.json(
      {
        available: false,
        normalized: norm.handle,
        reason: verdict.reason,
        error: "That handle is taken.",
      },
      { status: 200 }
    );
  } catch (err) {
    console.warn(
      "[waitlist/handle/availability] failed:",
      (err as Error).message
    );
    return NextResponse.json(
      { error: "Could not check availability. Try again." },
      { status: 500 }
    );
  }
}
