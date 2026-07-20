import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById, enqueueRoundup } from "@/lib/db";
import { awardForTx, type EarnTrigger } from "@/lib/rewards/earn";
import { requireAppAttestStructural } from "@/lib/app-attest";
import { takePendingRoundup } from "@/lib/perf-cache";

export const runtime = "nodejs";

/**
 * POST /api/send/gasless-confirm
 *
 * Post-broadcast bookkeeping for the `gasless-direct` rail (iOS broadcasts
 * the signed bytes to a Sui fullnode itself, then fires this once it has
 * a digest). Mirrors the deferred SnS + rewards crediting that
 * `/api/send/gasless-submit` does inline after its own broadcast.
 *
 * Returns 204 No Content, iOS does NOT need to await or retry this. The
 * Spend-and-Save and rewards crediting are best-effort by design, exactly
 * as they were inside `gasless-submit` (both were already wrapped in
 * void-IIFE / `.catch()` swallowers so a DB hiccup never failed a send).
 *
 * ── Idempotency ────────────────────────────────────────────────────
 *
 * Neither helper dedupes by digest on its own:
 *   • `enqueueRoundup` (web/lib/db.ts:1330) is a bare INSERT, no
 *     UNIQUE on digest, would double-enqueue on retry.
 *   • `awardForTx`     (web/lib/rewards/earn.ts:62) explicitly says
 *     "we DON'T dedupe by digest here" in the JSDoc and writes a
 *     rewards_events row + bumps lifetime tallies on every call.
 *
 * So idempotency is enforced at the route level via an in-memory dedupe
 * Map keyed on `${userId}:${digest}`, with a 60s TTL. A duplicate confirm
 * within the window is a fast 204 no-op. Cross-process or post-restart
 * retries would slip through, acceptable because (a) iOS doesn't retry
 * on 2xx and (b) the rail is fire-and-forget so iOS has no error signal
 * that would trigger a retry in the first place.
 */

const DEDUPE_TTL_MS = 60_000;
const recentConfirms = new Map<string, number>();

function dedupe(userId: number, digest: string): boolean {
  const key = `${userId}:${digest}`;
  const now = Date.now();
  const seenAt = recentConfirms.get(key);
  if (seenAt && now - seenAt < DEDUPE_TTL_MS) return true;
  recentConfirms.set(key, now);
  // Opportunistic eviction. Cheap and bounds the map so it doesn't grow
  // unboundedly under churn. Only runs when the map is getting large.
  if (recentConfirms.size > 1024) {
    for (const [k, ts] of recentConfirms) {
      if (now - ts >= DEDUPE_TTL_MS) recentConfirms.delete(k);
    }
  }
  return false;
}

export async function POST(req: Request) {
  const attestBlock = requireAppAttestStructural(req);
  if (attestBlock) return attestBlock;

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: {
    digest?: string;
    meta?: { kind?: string; amountUsd?: number; venue?: string };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const digest = body.digest;
  if (!digest || typeof digest !== "string") {
    return NextResponse.json({ error: "missing digest" }, { status: 400 });
  }

  // Idempotency: silently no-op duplicate confirms for the same
  // {userId, digest} within the TTL. iOS sees the same 204 either way.
  if (dedupe(userId, digest)) {
    console.log(
      `[send/gasless-confirm] user=${userId} digest=${digest} duplicate (60s TTL), skipping bookkeeping`
    );
    return new Response(null, { status: 204 });
  }

  // Deferred Spend-and-Save, same logic as gasless-submit lines 115–139.
  // `takePendingRoundup` is synchronous (in-memory map) and pops the
  // entry, so it's also naturally idempotent on its own, a second call
  // for the same user returns null. The enqueue is wrapped in a void IIFE
  // so a DB hiccup never affects the response.
  const pendingRoundupUsd = takePendingRoundup(userId);
  if (pendingRoundupUsd && pendingRoundupUsd > 0) {
    void (async () => {
      try {
        await enqueueRoundup({ userId, amountUsd: pendingRoundupUsd });
      } catch (e) {
        console.warn(
          `[send/gasless-confirm] enqueueRoundup failed (user=${userId}, amount=${pendingRoundupUsd}):`,
          (e as Error).message
        );
      }
    })();
  }

  // Rewards earn, same ALLOWED set + 10k USD cap as gasless-submit
  // lines 141–169.
  const meta = body.meta;
  if (
    meta &&
    typeof meta.kind === "string" &&
    typeof meta.amountUsd === "number" &&
    meta.amountUsd > 0
  ) {
    const ALLOWED: ReadonlySet<EarnTrigger> = new Set([
      "send",
      "invest",
      "withdraw",
      "roundup",
      "goal",
    ]);
    const trigger = meta.kind as EarnTrigger;
    if (ALLOWED.has(trigger)) {
      const amountUsd = Math.min(meta.amountUsd, 10_000);
      awardForTx({
        userId,
        trigger,
        amountUsd,
        digest,
        venue: meta.venue,
      }).catch((e) =>
        console.warn("[send/gasless-confirm] awardForTx failed:", e)
      );
    }
  }

  return new Response(null, { status: 204 });
}
