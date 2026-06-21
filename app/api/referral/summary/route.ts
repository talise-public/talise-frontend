import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { getRewardsSummary, userById } from "@/lib/db";
import { getRewardsExtras, POINT_RATES } from "@/lib/rewards/earn";
import { getRoundupConfig } from "@/lib/rewards/roundup";

export const runtime = "nodejs";

/**
 * Per-leg timeout fence. Same pattern as `lib/activity.ts` + the withdraw
 * routes — without this, a hung leg (the round-up config read previously
 * timed out for a single user, wedging the iOS -1001 cascade) blocks the
 * entire response past iOS's URLSession default and the client retries.
 *
 * On timeout: log loudly, resolve with `fallback` so the partial response
 * still ships. Errors are also swallowed to fallback — the iOS card has
 * its own empty-state, the alternative is a stalled feed.
 */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  leg: string,
  fallback: T
): Promise<T> {
  const start = Date.now();
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(
        `[referral/summary] ${leg} timed out after ${Date.now() - start}ms`
      );
      resolve(fallback);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        console.warn(
          `[referral/summary] ${leg} failed after ${Date.now() - start}ms: ${(e as Error).message}`
        );
        resolve(fallback);
      }
    );
  });
}

/**
 * Mobile-friendly rewards snapshot. Same source of truth as the web /rewards
 * page (lib/db.ts → getRewardsSummary) — only difference is the response
 * envelope shape, mapped to the iOS RewardsSummary Codable.
 *
 * Every leg is fenced with a hard per-leg timeout. Outer 8s ceiling on the
 * orchestrator guarantees iOS sees a response before its URLSession default
 * (60s) and the cascading -1001 retries fires.
 */
export async function GET(req: Request) {
  const t0 = Date.now();
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }
  try {
    // Empty-shaped fallbacks match the shape `getRewardsSummary` /
    // `getRewardsExtras` / `getRoundupConfig` would return — keeps the
    // response envelope unconditional so iOS Codable doesn't choke.
    const tFan = Date.now();
    const summaryFallback = {
      code: "",
      pointsTotal: 0,
      referralCount: 0,
      recentEvents: [],
    } as Awaited<ReturnType<typeof getRewardsSummary>>;
    const extrasFallback = {
      tier: {
        id: "bronze",
        label: "Bronze",
        pointsToNext: 0,
        nextLabel: "Silver",
      },
      lifetimeSentUsd: 0,
      lifetimeSavedUsd: 0,
      roundupEnabled: false,
      roundupPercentage: 0,
    } as Awaited<ReturnType<typeof getRewardsExtras>>;
    const roundupFallback = {
      enabled: false,
      percentage: 0,
      savedUsd: 0,
    } as Awaited<ReturnType<typeof getRoundupConfig>>;
    const [summary, extras, roundup] = await Promise.all([
      withTimeout(getRewardsSummary(userId), 3500, "db.summary", summaryFallback),
      withTimeout(getRewardsExtras(userId), 3500, "db.extras", extrasFallback),
      withTimeout(getRoundupConfig(userId), 3500, "db.roundup", roundupFallback),
    ]);
    const tDone = Date.now();
    console.log(
      `[referral/summary] user=${userId} fan=${tDone - tFan}ms total=${tDone - t0}ms`
    );
    return NextResponse.json({
      code: summary.code,
      pointsTotal: summary.pointsTotal,
      referralCount: summary.referralCount,
      // Tier (Bronze/Silver/Gold/Platinum) computed from pointsTotal.
      // Includes `pointsToNext` so the iOS card can render a progress
      // ring + "850 to Gold" hint without recomputing the thresholds.
      tier: {
        id: extras.tier.id,
        label: extras.tier.label,
        pointsToNext: extras.tier.pointsToNext,
        nextLabel: extras.tier.nextLabel,
      },
      // Lifetime tallies — used by the Rewards card stats row.
      // Lifetime, not monthly, because lifetime is what we can compute
      // cheaply from a single users-row read; monthly would need a
      // GROUP-BY on rewards_events.
      lifetimeSentUsd: extras.lifetimeSentUsd,
      lifetimeSavedUsd: extras.lifetimeSavedUsd,
      // Round-up config — drives the toggle + % slider on iOS.
      roundup: {
        enabled: roundup.enabled,
        percentage: roundup.percentage,
      },
      // Lifetime amount auto-swept via round-up. Rendered next to the
      // toggle on the iOS RoundupCard so users see their drip savings
      // accumulate. Separate from `lifetimeSavedUsd` (which includes
      // explicit invests + goal deposits too).
      roundupSavedUsd: roundup.savedUsd,
      // Point-earning rates so iOS can render "1 pt / $1 sent, 3 pts / $1 saved"
      // without hardcoding the values in two places.
      pointRates: POINT_RATES,
      recentEvents: summary.recentEvents.map((e) => ({
        id: String(e.id),
        kind: e.kind,
        points: e.points,
        createdAt: new Date(e.created_at).toISOString(),
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
