/**
 * Rewards + Referrals shared types.
 *
 * Mirrors the `GET /api/referral/summary` and `GET /api/rewards/catalogue`
 * response envelopes. Kept in one place so the page + cards agree on the
 * shape without re-declaring it. Source of truth lives server-side in
 * lib/rewards/{earn,catalogue}.ts.
 */

export type ReferralTier = {
  id: string;
  label: string;
  /** Points needed to reach the next tier. `null`/0 at top tier. */
  pointsToNext: number | null;
  nextLabel: string | null;
};

/** Points-per-$1 by motion. From the server's POINT_RATES. */
export type PointRates = {
  send: number;
  invest: number;
  withdraw: number;
  roundup: number;
  goal: number;
};

export type ReferralEvent = {
  id: string;
  kind: string;
  points: number;
  createdAt: string;
};

/** `GET /api/referral/summary` response. */
export type ReferralSummary = {
  code: string;
  pointsTotal: number;
  referralCount: number;
  tier: ReferralTier;
  lifetimeSentUsd: number;
  lifetimeSavedUsd: number;
  roundup: { enabled: boolean; percentage: number };
  roundupSavedUsd: number;
  pointRates: PointRates;
  recentEvents: ReferralEvent[];
};

/** One redeemable perk from `GET /api/rewards/catalogue`. */
export type CatalogueItem = {
  sku: string;
  label: string;
  description: string;
  pointsCost: number;
  kind: "instant" | "flagged" | "pending";
  icon: string | null;
  minTier: "bronze" | "silver" | "gold" | "plat" | null;
  stackable?: boolean;
  durationMs?: number | null;
  canAfford: boolean;
};

export type Catalogue = {
  pointsTotal: number;
  items: CatalogueItem[];
};
