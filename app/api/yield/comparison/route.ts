import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { getYieldComparison } from "@/lib/yield";
import {
  naviPositionFromActivity,
  type NaviPositionDetail,
} from "@/lib/navi-supply";
import { getRecentActivity } from "@/lib/activity";
import { readActivitySnapshot } from "@/lib/snapshots";

export const runtime = "nodejs";

/**
 * NAVI + DeepBook margin APY comparison for the authed user. The web
 * /earn page reads the same helper server-side; this endpoint just
 * exposes it for the mobile client.
 *
 * Response shape matches the iOS YieldComparison Codable
 * (venues[].venue, apy, supplied, pendingRewards, best).
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
  try {
    // Start the activity scan ALONGSIDE the venue reads. The replay only
    // needs the rows once we know the NAVI position, so overlapping the two
    // turns sum-of-latencies into max-of-latencies (this route used to run
    // them back-to-back and clock 4-6s for suppliers). For non-suppliers the
    // unused scan is typically one GraphQL page and resolves quietly.
    // Capped at 4s so a slow chain scan can't stall the Earn response — the
    // breakdown is a nice-to-have, the APY/venue is not.
    const activityPromise = Promise.race([
      getRecentActivity(user.sui_address, 200, { includeNonTalise: false }),
      new Promise<Awaited<ReturnType<typeof getRecentActivity>>>((r) =>
        setTimeout(() => r([]), 4_000)
      ),
    ]).catch(
      // Never reject — an unawaited rejection (non-supplier path) would
      // surface as an unhandled-rejection warning.
      () => [] as Awaited<ReturnType<typeof getRecentActivity>>
    );

    const cmp = await getYieldComparison(user.sui_address);

    // For Navi, additionally compute `earned` (current − principal)
    // and `earningPerDay` from a recent on-chain activity replay. We
    // scan a generous window (~200 txs) so historical supplies aren't
    // missed for long-tenured users. Activity is the source of truth
    // here — neither Navi's open API nor `@t2000/sdk`'s
    // `EarningsResult` exposes real accrued interest per user (the
    // SDK's `totalYieldEarned` is dailyEarning × 30, a projection,
    // not actual yield). See `naviPositionFromActivity` for the full
    // rationale.
    let naviDetail: NaviPositionDetail | null = null;
    const naviVenue = cmp.venues.find((v) => v.id === "navi");
    if (naviVenue && (naviVenue.supplied ?? 0) > 0) {
      try {
        let activity = await activityPromise;
        // The live walk times out at 4s (and the underlying tx-history
        // read flakes under RPC pressure) — when it comes back empty,
        // fall back to the persisted activity snapshot Home maintains.
        // Without this, `earned` silently vanished from the Earn screen
        // whenever the walk was slow, which read as "Talise lost my
        // earnings" (founder report, 2026-06-12).
        if (activity.length === 0) {
          const snap = await readActivitySnapshot(userId).catch(() => null);
          if (snap && Array.isArray(snap.entries)) {
            activity = snap.entries as typeof activity;
          }
        }
        const naviRows = activity
          .filter((a) => (a.venue ?? "").toLowerCase() === "navi")
          .map((a) => ({
            direction: a.direction,
            venue: a.venue,
            amountUsdsui: a.amountUsdsui,
            // The time-weighted projection fallback in
            // naviPositionFromActivity needs the EARLIEST invest
            // timestamp; the rest are ignored.
            timestampMs: a.timestampMs,
          }));
        naviDetail = naviPositionFromActivity({
          currentValue: naviVenue.supplied ?? 0,
          apy: naviVenue.apy,
          naviActivity: naviRows,
        });
      } catch (e) {
        // Activity feed failures are non-fatal — we'll just omit the
        // breakdown and let iOS render the legacy single "Earning / day"
        // row.
        console.warn(
          `[yield/comparison] navi activity replay failed: ${(e as Error).message}`
        );
      }
    }

    const venues = cmp.venues.map((v) => {
      const base = {
        venue: v.id,
        apy: v.apy,
        supplied: v.supplied ?? 0,
        pendingRewards:
          (v.meta as { pendingUsd?: number } | undefined)?.pendingUsd ?? 0,
      };
      if (v.id === "navi" && naviDetail) {
        return {
          ...base,
          // USD amounts (USDsui is 1:1 USD). iOS converts to local
          // currency at render time.
          earned: naviDetail.earned,
          earningPerDay: naviDetail.dailyEarning,
          principalSupplied: naviDetail.principalSupplied,
          // Epoch-ms the current earning streak began — the client ticks
          // `earned` live (currentValue × apy × elapsed/year) + projects
          // year-end (currentValue × apy) from this.
          earningSinceMs: naviDetail.earningSinceMs,
        };
      }
      return base;
    });
    const best = cmp.best
      ? {
          venue: cmp.best.id,
          apy: cmp.best.apy,
          supplied: cmp.best.supplied ?? 0,
          pendingRewards: 0,
        }
      : null;
    return NextResponse.json(
      { venues, best },
      {
        // APYs move slowly — 60s edge cache + 5min SWR cuts the load
        // on Navi's open API and the on-chain reserve reads when many
        // mobile clients refresh at once. memoTtl in navi-supply gives
        // us a second per-process layer.
        headers: {
          "Cache-Control": "s-maxage=60, stale-while-revalidate=300",
        },
      }
    );
  } catch (err) {
    // Earn shouldn't 500 the UI just because a venue's RPC is flaky —
    // surface an empty comparison and let the client render "Unavailable".
    console.warn(`[yield/comparison] failed: ${(err as Error).message}`);
    return NextResponse.json({ venues: [], best: null });
  }
}
