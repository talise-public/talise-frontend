import "server-only";

/**
 * Talise Yield Router — the pure decision core (Phase 0).
 *
 * Stateless functions over venue snapshots: rank the safe USDC venues,
 * respect per-venue risk caps, pick the best, and decide whether to ROTATE
 * an existing position to a better venue. There is NO money path here — this
 * module only ranks + decides. The actual deposit/withdraw/rotate PTBs are
 * built elsewhere (per-venue adapters + the talise_yield package); keeping
 * the optimizer pure makes it trivially testable and impossible to misuse to
 * move funds. See docs/strategy/YIELD-ROUTER.md.
 *
 * Venues are an ALLOWLIST (the 4 safest USDC supply primitives on Sui).
 * Aggregators (SAM, Kai, Mole, Aftermath) are deliberately NOT here — we
 * never nest an aggregator inside our own router.
 */

export type RouterVenueId = "suilend" | "navi" | "alphalend" | "scallop";

/** Risk tier + the max share of a user's yield portfolio a venue may hold.
 *  Bounds blast radius: a single venue failure can only touch its cap. */
export const VENUE_RISK: Record<
  RouterVenueId,
  { tier: 1 | 2 | 3; maxAllocationBps: number; name: string }
> = {
  // Core: deepest TVL, OtterSec-audited, multi-year clean records.
  suilend: { tier: 1, maxAllocationBps: 10_000, name: "Suilend" },
  navi: { tier: 1, maxAllocationBps: 10_000, name: "NAVI" },
  // Growth: clean primitive but youngest (launched 2025) → capped.
  alphalend: { tier: 2, maxAllocationBps: 4_000, name: "AlphaLend" },
  // Monitored: mature + multi-audited but had an Apr-2026 deprecated-contract
  // exploit → small cap, circuit-breaker eligible.
  scallop: { tier: 3, maxAllocationBps: 1_500, name: "Scallop" },
};

export type VenueSnapshot = {
  id: RouterVenueId;
  /** Live supply APY as a fraction (0.0823 = 8.23%). */
  apy: number;
  /** User's USDC currently supplied here (0 if none). */
  supplied: number;
  /** Venue TVL, if known — informational / circuit-breaker input. */
  tvl?: number;
  /** Circuit breaker: true → don't route in, recommend exit. */
  paused?: boolean;
};

/**
 * Rotation hysteresis. A candidate must beat the current venue by MORE than
 * this *plus* the amortized move cost before we recommend rotating — otherwise
 * we churn on noise and bleed the swap+gas cost on every wiggle. This guard is
 * the single most important thing separating a profitable rotator from a
 * value-destroying one.
 */
export const REBALANCE_THRESHOLD_BPS = 75; // 0.75% APY improvement, net
/** Amortized round-trip cost of a rotation (withdraw + USDC swap + deposit +
 *  gas), expressed as APY-equivalent bps over a typical hold. Tunable. */
export const MOVE_COST_BPS = 35;

const bps = (x: number) => x * 10_000;

/** Venues that are eligible to RECEIVE funds right now: allowlisted, not
 *  paused, with a usable APY. Sorted best-APY first. */
export function rankVenues(snapshots: VenueSnapshot[]): VenueSnapshot[] {
  return snapshots
    .filter((s) => s.id in VENUE_RISK && !s.paused && Number.isFinite(s.apy) && s.apy > 0)
    .sort((a, b) => b.apy - a.apy);
}

/** The single best venue to route a NEW deposit into (Phase 0/1 model).
 *  Returns null if nothing is eligible. */
export function pickBest(snapshots: VenueSnapshot[]): VenueSnapshot | null {
  return rankVenues(snapshots)[0] ?? null;
}

export type RebalanceDecision = {
  shouldMove: boolean;
  from: RouterVenueId | null;
  to: RouterVenueId | null;
  /** Net APY gain in bps after subtracting the move cost (negative if not worth it). */
  netGainBps: number;
  reason: string;
};

/**
 * Decide whether an existing position in `current` should rotate. Moves only
 * when the best eligible venue beats the current APY by more than the
 * hysteresis threshold once the move cost is netted out — OR when the current
 * venue is paused (forced exit to the best alternative).
 */
export function rebalanceDecision(
  current: RouterVenueId | null,
  currentApy: number,
  snapshots: VenueSnapshot[]
): RebalanceDecision {
  const ranked = rankVenues(snapshots);
  const best = ranked[0] ?? null;

  if (!best) {
    return { shouldMove: false, from: current, to: null, netGainBps: 0, reason: "no eligible venue" };
  }
  if (current == null) {
    return { shouldMove: true, from: null, to: best.id, netGainBps: bps(best.apy), reason: "initial placement" };
  }

  // Forced exit: the venue we're in went paused (circuit breaker tripped).
  const currentPaused = snapshots.find((s) => s.id === current)?.paused === true;
  if (currentPaused && best.id !== current) {
    return { shouldMove: true, from: current, to: best.id, netGainBps: bps(best.apy - currentApy), reason: "current venue paused — forced exit" };
  }

  if (best.id === current) {
    return { shouldMove: false, from: current, to: current, netGainBps: 0, reason: "already in best venue" };
  }

  const grossGainBps = bps(best.apy - currentApy);
  const netGainBps = grossGainBps - MOVE_COST_BPS;
  const worth = netGainBps > REBALANCE_THRESHOLD_BPS;
  return {
    shouldMove: worth,
    from: current,
    to: worth ? best.id : current,
    netGainBps,
    reason: worth
      ? `${best.id} beats ${current} by ${grossGainBps.toFixed(0)}bps (net ${netGainBps.toFixed(0)}bps after move cost)`
      : `gain ${netGainBps.toFixed(0)}bps below ${REBALANCE_THRESHOLD_BPS}bps threshold — hold`,
  };
}

/**
 * Multi-venue split (Phase 3 / pooled). Greedily fills the highest-APY venues
 * first, never exceeding each venue's risk cap, until `total` USDC is placed.
 * Returns the per-venue USDC allocation. Used when we diversify rather than
 * single-best — keeps Scallop/AlphaLend exposure within their caps by design.
 */
export function allocate(
  snapshots: VenueSnapshot[],
  total: number
): Array<{ id: RouterVenueId; usdc: number }> {
  if (total <= 0) return [];
  const ranked = rankVenues(snapshots);
  const out: Array<{ id: RouterVenueId; usdc: number }> = [];
  let remaining = total;
  for (const v of ranked) {
    if (remaining <= 0) break;
    const cap = (VENUE_RISK[v.id].maxAllocationBps / 10_000) * total;
    const put = Math.min(cap, remaining);
    if (put > 0) {
      out.push({ id: v.id, usdc: put });
      remaining -= put;
    }
  }
  // If caps left a remainder (e.g. only capped venues available), top up the
  // safest tier-1 venue we already used rather than leaving cash idle.
  if (remaining > 0 && out.length) {
    const t1 = out.find((o) => VENUE_RISK[o.id].tier === 1) ?? out[0];
    t1.usdc += remaining;
  }
  return out;
}
