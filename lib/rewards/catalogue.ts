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
/**
 * REMOVED (audit H2/H10, 2026-07-24): `airtime_ngn_500` was the only
 * points-→-real-value sink, and it was `stackable: true`, so it skipped the
 * "already active" check in `redeem.ts` and could be redeemed repeatedly.
 * Combined with points that can be minted from nothing, that was an open cash
 * faucet. The catalogue is intentionally EMPTY: points accrue but cannot be
 * converted to value. Do not re-add a SKU until points issuance is
 * rate-limited, capped, and the redeem debit is atomic.
 *
 * ── Status of those preconditions (2026-07-25) ──────────────────────
 *
 * The issuance side is now sound, so this list is a decision rather than
 * a blocker:
 *   ✔ Points from a money action are derived from a CHAIN-VERIFIED amount
 *     bound to the user's own address (lib/rewards/verify.ts), never from
 *     a client-asserted `meta.amountUsd`.
 *   ✔ Every award is idempotent behind a UNIQUE claim key, and a digest
 *     can fund one primary trigger for one account
 *     (lib/rewards/integrity.ts).
 *   ✔ Capped: DAILY_EARN_POINTS_CAP per user per UTC day, plus
 *     per-inviter daily + lifetime referral caps and a KYC gate
 *     (lib/rewards-constants.ts → REFERRAL_LIMITS).
 *   ✔ Signup pays zero; referral value is paid only on a verified first
 *     money movement by the referee (lib/rewards/referral.ts).
 *   ✔ The redeem debit is atomic and flagged accounts can't redeem
 *     (lib/rewards/redeem.ts), and a clawback path exists
 *     (POST /api/admin/rewards).
 *
 * REMAINING before a real-value SKU ships: `stackable` must stay FALSE
 * (or carry its own per-period quota), and a `pending`-kind SKU needs an
 * operator who will actually call the fulfilment endpoint.
 */
export const CATALOGUE: RedeemSKU[] = [];

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
