import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { readActivitySnapshot, refreshInBackground } from "@/lib/snapshots";
import {
  computeLiveActivity,
  ACTIVITY_SNAPSHOT_SERVE_MAX_MS,
  ACTIVITY_SNAPSHOT_BG_REFRESH_MS,
  type SerializedEntry,
} from "@/lib/activity-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/activity?limit=20, recent on-chain activity for the authed
 * user. Source of truth is the chain; a per-user Postgres snapshot serves
 * an instant first paint and is refreshed from chain in the background.
 * `?fresh=1` always reads the chain (the post-send reconcile path).
 *
 * Response: { entries: [...] } in the iOS-friendly row shape, plus
 * additive { refreshedAt, stale, source } the client may ignore.
 */
export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? 20);
  const limit = Math.max(1, Math.min(50, Number.isFinite(rawLimit) ? rawLimit : 20));
  // `fresh=1` bypasses BOTH the snapshot and the in-process memo. iOS sets
  // this on the post-send/supply/swap reconcile so a tx that just landed
  // isn't hidden behind a stale slice (HomeView.applyOptimisticTx → reconcile).
  const bypassCache = url.searchParams.get("fresh") === "1";

  // Snapshot-first: serve a reasonably-fresh last-known feed instantly and
  // refresh from chain in the background. Never on ?fresh=1.
  if (!bypassCache) {
    const snap = await readActivitySnapshot(userId);
    if (snap && Date.now() - snap.refreshedAt <= ACTIVITY_SNAPSHOT_SERVE_MAX_MS) {
      const ageMs = Date.now() - snap.refreshedAt;
      if (ageMs > ACTIVITY_SNAPSHOT_BG_REFRESH_MS) {
        refreshInBackground(async () => {
          await computeLiveActivity(
            { id: user.id, sui_address: user.sui_address, talise_vault_id: user.talise_vault_id ?? null },
            limit,
            false
          );
        });
      }
      const entries = (snap.entries as SerializedEntry[]).slice(0, limit);
      return NextResponse.json(
        { entries, refreshedAt: snap.refreshedAt, stale: ageMs > ACTIVITY_SNAPSHOT_BG_REFRESH_MS, source: "snapshot" },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }
  }

  // BOUNDED live scan. The on-chain tx-history walk can crawl on a struggling
  // RPC (we saw ~47s). The feed is display-only, so never make the user wait:
  // cap the scan and fall back to the freshest snapshot. The in-flight scan
  // keeps running and write-throughs the monotonic snapshot floor, so it
  // self-heals for the next load.
  const LIVE_BUDGET_MS = 7000;
  const TIMED_OUT = Symbol("timeout");
  try {
    const livePromise = computeLiveActivity(
      { id: user.id, sui_address: user.sui_address, talise_vault_id: user.talise_vault_id ?? null },
      limit,
      bypassCache
    );
    livePromise.catch(() => {}); // abandoned slow scan must not reject unhandled
    const raced = await Promise.race([
      livePromise,
      new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), LIVE_BUDGET_MS)),
    ]);
    if (raced !== TIMED_OUT) {
      return NextResponse.json(
        { entries: raced, refreshedAt: Date.now(), stale: false, source: "chain" },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }
    // Scan blew the budget, serve the freshest snapshot (any age beats a spinner).
    const snap = await readActivitySnapshot(userId).catch(() => null);
    return NextResponse.json(
      {
        entries: snap ? (snap.entries as SerializedEntry[]).slice(0, limit) : [],
        refreshedAt: snap?.refreshedAt ?? 0,
        stale: true,
        source: "snapshot-timeout",
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (err) {
    console.warn(`[api/activity] failed: ${(err as Error).message}`);
    // Last resort: serve the immutable snapshot floor rather than blanking the
    // feed. History must never shrink just because a live compute threw.
    const snap = await readActivitySnapshot(userId).catch(() => null);
    const entries = snap ? (snap.entries as SerializedEntry[]).slice(0, limit) : [];
    return NextResponse.json(
      {
        entries,
        refreshedAt: snap?.refreshedAt ?? 0,
        stale: true,
        source: "snapshot-fallback",
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
