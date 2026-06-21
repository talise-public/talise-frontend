import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { getYieldComparison } from "@/lib/yield";
import { rebalanceDecision, type VenueSnapshot } from "@/lib/yield/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Stable zero address — APYs are global, so we don't need a real user here. */
const ZERO_ADDR =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/** global_kv key holding the once-a-day best-yield snapshot. */
const SNAPSHOT_KEY = "yield_best_daily";

/**
 * GET /api/cron/yield-rebalance — the once-a-day "check best yield" heartbeat.
 *
 * SAM-style routing has two halves:
 *   • ROUTE TO BEST — new deposits already resolve `venue:"best"` at deposit
 *     time (app/api/earn/supply/prepare), so money always lands in the top
 *     live venue. This cron refreshes the global APY caches once a day so that
 *     resolution is cheap + stable rather than a per-request live fetch.
 *   • REBALANCE — compares the new best against the previously-recorded best
 *     via `rebalanceDecision` (hysteresis + move-cost netting) and records the
 *     verdict. Funds sit in per-user, NON-CUSTODIAL positions, so this cron
 *     cannot move them itself; the recorded decision is what the app acts on
 *     (a sponsored rotation on next open when the best has genuinely moved).
 *
 * Auth: Vercel injects `Authorization: Bearer $CRON_SECRET` on scheduled runs.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  try {
    await ensureSchema();

    // Read the previous daily best (if any) to compute the rebalance verdict.
    let prevBest: string | null = null;
    let prevApy = 0;
    try {
      const r = await db().execute({
        sql: `SELECT v_text FROM global_kv WHERE k = ?`,
        args: [SNAPSHOT_KEY],
      });
      const raw = r.rows[0]?.v_text as string | undefined;
      if (raw) {
        const prev = JSON.parse(raw) as { best?: string; apy?: number };
        prevBest = prev.best ?? null;
        prevApy = prev.apy ?? 0;
      }
    } catch {
      /* no prior snapshot — treat as initial placement */
    }

    // Refresh global APYs + pick the current best (positions irrelevant here).
    const cmp = await getYieldComparison(ZERO_ADDR);
    const ROUTER_IDS = new Set(["suilend", "navi", "alphalend", "scallop"]);
    const snapshots: VenueSnapshot[] = cmp.venues
      .filter((v) => ROUTER_IDS.has(v.id))
      .map((v) => ({
        id: v.id as VenueSnapshot["id"],
        apy: v.apy,
        supplied: 0,
        paused: false,
      }));

    const decision = rebalanceDecision(
      (prevBest as VenueSnapshot["id"] | null) ?? null,
      prevApy,
      snapshots
    );

    const now = Date.now();
    const snapshot = {
      best: cmp.best?.id ?? null,
      apy: cmp.best?.apy ?? 0,
      venues: cmp.venues.map((v) => ({ id: v.id, apy: v.apy })),
      checkedAt: now,
      rebalance: {
        shouldMove: decision.shouldMove,
        from: decision.from,
        to: decision.to,
        netGainBps: decision.netGainBps,
        reason: decision.reason,
      },
    };

    await db().execute({
      sql: `INSERT INTO global_kv (k, v_text, refreshed_at) VALUES (?, ?, ?)
            ON CONFLICT (k) DO UPDATE SET v_text = EXCLUDED.v_text, refreshed_at = EXCLUDED.refreshed_at`,
      args: [SNAPSHOT_KEY, JSON.stringify(snapshot), now],
    });

    return NextResponse.json({ ok: true, ...snapshot });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
