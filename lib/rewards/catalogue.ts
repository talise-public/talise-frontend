/**
 * Talise Rewards, redemption catalogue (Phase 4).
 *
 * Pure constants. No DB, no fetch, no `server-only` pragma, safe to
 * import from anywhere on the server (the iOS app reads the filtered
 * catalogue via `/api/rewards/catalogue`, so client code never imports
 * this file directly, but keeping it pure means future-flagging this
 * for a web view is a copy-paste away).
 *
 * v1 inventory is hardcoded. There's no admin UI yet, when the user
 * wants to tune cost / description / availability they edit this file.
 *
 * Fulfillment kinds:
 *   `instant`, auto-fulfilled at redeem time (no manual work)
 *   `flagged`, stored as metadata on the redemption row; a future
 *                policy check reads it (e.g. fx_boost_until_ms). The
 *                redemption row's `status` flips to `fulfilled` at
 *                redeem time but the *effect* is deferred to other
 *                code paths that honor the metadata.
 *   `pending`, requires manual outbound action (e.g. payout). The
 *                redemption row sits at `pending` until an operator
 *                flips it.
 */

export type RedeemKind = "instant" | "flagged" | "pending";

export interface RedeemSKU {
  /** Stable id, never reuse for a different perk. */
  sku: string;
  /** Card title shown on iOS. */
  label: string;
  /** One-line description under the title. */
  description: string;
  /** Cost in points (positive integer). */
  pointsCost: number;
  /** Fulfillment kind, drives status assignment on redeem. */
  kind: RedeemKind;
  /** False = hidden from the API response (kill switch). */
  enabled: boolean;
  /** Optional SF Symbol used by the iOS card. */
  icon?: string;
  /**
   * Optional tier gate, when set, the SKU is hidden / locked for users
   * below this tier. Phase 4 ships without any tier gates, but the
   * field is here so future entries can use it.
   */
  minTier?: "bronze" | "silver" | "gold" | "plat";
  /**
   * True = the user can hold multiple active copies (e.g. donations).
   * Default false: re-redeeming the same SKU while one is still active
   * is rejected by lib/rewards/redeem.ts. (The 5-minute debounce is a
   * separate concern, that one fires regardless of stackability.)
   */
  stackable?: boolean;
  /**
   * For `flagged` SKUs that grant a time-bounded effect, this is the
   * window in ms. lib/rewards/redeem.ts stamps `activeUntilMs` =
   * now + durationMs into the redemption's metadata.
   */
  durationMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * v1 catalogue. Stripped to a single redeemable: airtime credit.
 *
 * The earlier multi-SKU set (fee waiver, FX boost, tier skip, early
 * access, UNICEF donation) felt aspirational, none of them tied to
 * something the African-corridor user wakes up wanting. Airtime is
 * universally desired in the target market and concrete enough that
 * users immediately understand the points-→-perk loop.
 *
 * Fulfillment is `pending`: the redemption row lands at `status:
 * "pending"` and an operator credits the user's phone with airtime
 * (off-platform) before flipping to `fulfilled`. Future: integrate
 * Yellow Card / Reloadly / Africa's Talking for real-time top-ups.
 */
export const CATALOGUE: RedeemSKU[] = [
  {
    sku: "airtime_ngn_500",
    label: "Claim ₦500 airtime",
    description:
      "Redeem your points for ₦500 of mobile credit. We'll send to your phone within 24 hours.",
    pointsCost: 500,
    kind: "pending",
    enabled: true,
    icon: "phone.fill",
    stackable: true,
  },
];

/** Map of sku → entry for O(1) lookup in the redeem path. */
const BY_SKU: Record<string, RedeemSKU> = Object.fromEntries(
  CATALOGUE.map((s) => [s.sku, s])
);

export function findSku(sku: string): RedeemSKU | null {
  return BY_SKU[sku] ?? null;
}

/** Visible catalogue (enabled only). */
export function visibleCatalogue(): RedeemSKU[] {
  return CATALOGUE.filter((s) => s.enabled);
}
