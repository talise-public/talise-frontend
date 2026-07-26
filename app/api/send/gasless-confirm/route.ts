import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { awardForTx, type EarnTrigger } from "@/lib/rewards/earn";
import { requireAppAttestStructural } from "@/lib/app-attest";
import { trackConfirmedExecution } from "@/lib/analytics/emit";

export const runtime = "nodejs";

/**
 * POST /api/send/gasless-confirm
 *
 * Post-broadcast bookkeeping for the `gasless-direct` rail (iOS broadcasts
 * the signed bytes to a Sui fullnode itself, then fires this once it has
 * a digest). Mirrors the rewards crediting that
 * `/api/send/gasless-submit` does inline after its own broadcast.
 *
 * Returns 204 No Content, iOS does NOT need to await or retry this. The
 * rewards crediting is best-effort by design, exactly as it was inside
 * `gasless-submit` (already wrapped in a `.catch()` swallower so a DB
 * hiccup never failed a send).
 *
 * ── Idempotency ────────────────────────────────────────────────────
 *
 * `awardForTx` (web/lib/rewards/earn.ts) takes a UNIQUE claim key per
 * (user, digest, trigger) before minting anything, so a duplicate confirm
 * cannot double-credit. The route-level dedupe below is the cheaper first
 * line of defence: an in-memory Map keyed on `${userId}:${digest}`, with a
 * 60s TTL. A duplicate confirm within the window is a fast 204 no-op.
 * Cross-process or post-restart retries fall through to the claim key.
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

  // Spend + Save is NOT handled here. A Save-ON send never takes the gasless
  // rail (the validator's gasless allowlist admits only
  // `0x2::balance::send_funds<T>`, so a NAVI supply cannot ride along), so
  // sponsor-prepare routes it to the sponsored rail and the save is settled
  // in `/api/zk/sponsor-execute` against the send's own digest. See
  // lib/rewards/roundup.ts.

  // GROWTH: the `gasless-direct` rail, where iOS broadcasts to a fullnode itself
  // and only tells us afterwards. It never touches gasless-submit, so without
  // this call that rail's sends would be missing from `send_completed` entirely.
  // Sits BELOW the 60s dedupe gate, so a duplicate confirm is already a fast 204
  // and cannot double-count; the set-once milestone columns are the second line
  // of defence. Same non-blocking contract as the other two rails.
  trackConfirmedExecution({
    userId,
    digest,
    kind: body.meta?.kind,
    amountUsd: body.meta?.amountUsd,
    venue: body.meta?.venue,
    surface: "send.gasless_direct",
  });

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
