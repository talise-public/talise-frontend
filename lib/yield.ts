import "server-only";

import type { PendingReward } from "@t2000/sdk";
import {
  fetchUsdsuiMarginApy,
  fetchUserUsdsuiSupply,
} from "./deepbook-margin";
import {
  fetchNaviUsdsuiSupplyApy,
  readNaviUsdsuiSupply,
} from "./navi-supply";
import { getGlobalNum, setGlobalNum, refreshInBackground } from "./snapshots";
import { samConfigured, fetchSamApy, readSamPosition } from "./yield/sam";
import { fetchScallopUsdsuiApy } from "./yield/venues-mainnet";
import { SCALLOP_SUPPLY_ENABLED } from "./yield/ptb";

/** Resolve a promise to `fallback` if it doesn't settle within `ms`. The
 *  underlying work keeps running; we just stop waiting on the hot path. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/** Serve a cached venue APY without blocking for up to this long. APYs move
 *  slowly (basis points per hour), so 10 minutes of staleness is invisible
 *  on the Earn page while turning the hot path into one indexed PK read. */
const APY_SERVE_TTL_MS = 10 * 60_000;
/** Past this age, a served cached APY also kicks off a background live
 *  refresh (Next `after()`), so the cache converges on fresh within one
 *  page view of going stale. */
const APY_BG_REFRESH_MS = 2 * 60_000;

/**
 * A venue APY backed by the durable global cache, mirroring
 * `resolveSuiPrice()` in /api/balances: serve the cached value INSTANTLY
 * when it's recent enough (refreshing in the background once it passes the
 * refresh horizon), and only block on the live venue read when the cache is
 * empty or too old to serve blind. Previously this always blocked on the
 * live legs (NAVI open API + DeepBook on-chain stats, each capped at 5s) and
 * used the cache only as a failure fallback, that's where the 4-6s
 * /api/yield/comparison responses came from.
 *
 * Stale-honest beats blank (2026-06-11 ₦0-balance incident): if the live
 * read fails or times out but ANY cached APY exists, however old, serve
 * it rather than dropping the venue. Returns null only when we have neither
 * a live nor a cached APY.
 */
async function resolveVenueApy(
  key: string,
  liveFetch: () => Promise<number | null>
): Promise<number | null> {
  const g = await getGlobalNum(key).catch(() => null);
  const age = g ? Date.now() - g.refreshedAt : Number.POSITIVE_INFINITY;

  if (g && g.value > 0 && age <= APY_SERVE_TTL_MS) {
    if (age > APY_BG_REFRESH_MS) {
      refreshInBackground(async () => {
        const fresh = await liveFetch().catch(() => null);
        if (typeof fresh === "number" && Number.isFinite(fresh) && fresh > 0) {
          await setGlobalNum(key, fresh);
        }
      });
    }
    return g.value;
  }

  // No usable row (or too old to serve blind), pay the capped live read
  // once, then persist after the response flushes.
  const live = await withTimeout(
    liveFetch().catch(() => null),
    YIELD_LEG_TIMEOUT_MS,
    null
  );
  if (typeof live === "number" && Number.isFinite(live) && live > 0) {
    refreshInBackground(async () => setGlobalNum(key, live));
    return live;
  }

  return g && g.value > 0 ? g.value : null;
}

/** Per-leg cap so one slow venue read can't hang the whole comparison.
 *  The direct NAVI read (config+pools cached → a single per-user
 *  `devInspect`) settles well under this; it stays comfortably below the
 *  iOS 15s request deadline. */
const YIELD_LEG_TIMEOUT_MS = 5_000;

/**
 * Server-side yield queries, all stateless (no zkLogin signer needed).
 *
 * The NAVI position is read DIRECTLY (no @t2000/sdk): `readNaviUsdsuiSupply`
 * does one `devInspect` of NAVI's on-chain `get_user_state` getter for the
 * supplied balance, and `fetchNaviUsdsuiSupplyApy` reads the portal-accurate
 * APY from NAVI's open API. This replaced @t2000/sdk's `getFinancialSummary`
 * (which cost ~4.2s and keyed the APY off USDC's pool, a SDK bug).
 *
 * Pending rewards are not surfaced from the direct read (NAVI's reward
 * getter would add a second `devInspect`; the only consumer is the USD
 * total in `/api/yield/comparison`, which tolerates 0). `pending` is kept
 * in the return shape (empty) so callers + the iOS Codable don't change.
 */

export type EarnSnapshot = {
  /** USDsui currently supplied to NAVI lending. Human units. */
  supplied: number;
  /** Current supply APY as a fraction (0.0823 = 8.23%). */
  apy: number;
  /** Projected daily yield at the current APY. */
  dailyYield: number;
  /** Pending claimable rewards (per token). Currently always empty -
   *  see the module note above. */
  pending: PendingReward[];
  /** Sum of USD valuations across all pending rewards. */
  totalPendingUsd: number;
};

export async function getEarnSnapshot(address: string): Promise<EarnSnapshot> {
  const [supplied, apyLive] = await Promise.all([
    readNaviUsdsuiSupply(address).catch(() => 0),
    fetchNaviUsdsuiSupplyApy().catch(() => null),
  ]);

  const apy = apyLive ?? 0;
  const dailyYield = supplied * (apy / 365);

  return { supplied, apy, dailyYield, pending: [], totalPendingUsd: 0 };
}

/**
 * Cross-venue yield comparison: returns NAVI + DeepBook margin USDsui
 * APYs side-by-side plus a `best` pointer at whichever is higher right
 * now. The `/earn` page surfaces both as picker tiles; the chat agent
 * uses `best` to answer "what's the best place to put my dollars?".
 *
 * Each venue's APY is fetched independently and failures are
 * non-fatal, if one venue is offline we still return the other.
 */
export type YieldVenue = {
  id: "navi" | "deepbook" | "sam" | "scallop" | "suilend" | "alphalend";
  name: string;
  apy: number;
  /** User's currently supplied USDsui, if any. */
  supplied?: number;
  /** Extra venue-specific context for the UI. */
  meta?: Record<string, unknown>;
};

export type YieldComparison = {
  venues: YieldVenue[];
  best: YieldVenue | null;
};

export async function getYieldComparison(
  address: string
): Promise<YieldComparison> {
  // Two kinds of legs run in parallel here:
  //
  //   APYs (global, same for every user), resolved through the durable
  //   global_kv cache via `resolveVenueApy`, so the common case is a
  //   ~10-50ms DB read instead of a 1-5s NAVI open-API / DeepBook on-chain
  //   round trip. Cold serverless instances and transient RPC outages still
  //   return last-known APYs.
  //
  //   Positions (per-user), must stay live (one NAVI `devInspect` + one
  //   DeepBook SupplierCap lookup), but each is timeout-capped and
  //   failure-tolerant so a slow/flaky read degrades to supplied=0 rather
  //   than stalling or emptying the comparison.
  const [naviApy, deepbookApy, scallopApy, naviSupplied, dbSupply] = await Promise.all([
    resolveVenueApy("navi_usdsui_apy", () => fetchNaviUsdsuiSupplyApy()),
    resolveVenueApy(
      "deepbook_usdsui_apy",
      async () => (await fetchUsdsuiMarginApy())?.apy ?? null
    ),
    // Scallop USDsui supply, the second live aggregator-router venue. Read
    // from Scallop's market API (USDsui pool), cached like the others.
    resolveVenueApy("scallop_usdsui_apy", () => fetchScallopUsdsuiApy()),
    withTimeout(readNaviUsdsuiSupply(address).catch(() => 0), YIELD_LEG_TIMEOUT_MS, 0),
    withTimeout(fetchUserUsdsuiSupply(address).catch(() => null), YIELD_LEG_TIMEOUT_MS, null),
  ]);

  const venues: YieldVenue[] = [];
  if (naviApy != null) {
    venues.push({
      id: "navi",
      name: "NAVI lending",
      apy: naviApy,
      supplied: naviSupplied,
      // Pending rewards aren't surfaced from the direct NAVI read, see the
      // module note above. Kept in `meta` so consumers don't change shape.
      meta: { pendingUsd: 0 },
    });
  }
  if (deepbookApy != null) {
    venues.push({
      id: "deepbook",
      name: "DeepBook margin",
      apy: deepbookApy,
      supplied: dbSupply?.amount ?? 0,
      meta: {
        supplierCapId: dbSupply?.supplierCapId,
      },
    });
  }
  // Scallop, USDsui supply market. GATED: supply currently reverts on a stale
  // version object (see SCALLOP_SUPPLY_ENABLED in lib/yield/ptb.ts), so we don't
  // surface it as a depositable venue, that would route "best" to a venue whose
  // deposit reverts on chain. Re-enable once the version object is refreshed.
  if (SCALLOP_SUPPLY_ENABLED && scallopApy != null) {
    venues.push({
      id: "scallop",
      name: "Scallop lending",
      apy: scallopApy,
      supplied: 0,
      meta: { router: true },
    });
  }
  // SAM, the aggregating vault venue (Scallop/Suilend/NAVI + compounded
  // rewards behind one share token). Dormant until its on-chain interface is
  // configured (samConfigured()); then it reads its offered APY + the user's
  // samUSDC position and joins the comparison, typically as `best` since it
  // aggregates the very markets above. Failure-tolerant like the other legs.
  if (samConfigured()) {
    const [samApy, samPos] = await Promise.all([
      resolveVenueApy("sam_usdc_apy", () => fetchSamApy()),
      withTimeout(readSamPosition(address).catch(() => null), YIELD_LEG_TIMEOUT_MS, null),
    ]);
    if (samApy != null) {
      venues.push({
        id: "sam",
        name: "SAM vault",
        apy: samApy,
        supplied: samPos?.value ?? 0,
        meta: { shares: samPos?.shares ?? 0, aggregator: true },
      });
    }
  }

  venues.sort((a, b) => b.apy - a.apy);
  return { venues, best: venues[0] ?? null };
}
