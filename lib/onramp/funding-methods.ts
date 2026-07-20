/**
 * Funding-method model for the Talise on-ramp.
 *
 * Master plan §4/§6: card on-ramp economics are *negative* (Stripe charges
 * ~2.9% + $0.30, which alone exceeds Talise's ~80bps gross spread), so the
 * product MUST default to bank-rail funding and treat card as a surcharged
 * convenience tier. This module is the single source of truth for the set of
 * funding methods and their surfaced cost, the GET /api/onramp/methods route
 * renders these to the client so the UI can default to bank.
 *
 * Pure, no I/O. Fees are deterministic functions of the funded amount so they
 * can run on either side of the wire.
 */

/** Bank ACH/wire (T+1ish, ~free), instant FedNow/RTP, or card (surcharged). */
export type FundingMethod = "bank_ach" | "fednow" | "card";

/** Settlement speed surfaced to the client, independent of fee. */
export type FundingSpeed = "instant" | "same_day" | "next_day";

/**
 * Per-method fee parameters. Card passes the processor cost (Stripe Crypto
 * Onramp) through explicitly, Talise eats none of it and adds no markup, so
 * the user sees exactly why card is more expensive. Bank rails are ~free
 * because Circle Mint settles USD wire/ACH → USDC on Sui at par (see
 * circle-mint.ts).
 */
type FundingFeeSpec = {
  /** Proportional fee as a fraction of the funded amount (e.g. 0.029 = 2.9%). */
  readonly rate: number;
  /** Flat fee in USD added on top of the proportional fee. */
  readonly flatUsd: number;
};

const FEE_SPEC: Record<FundingMethod, FundingFeeSpec> = {
  // Bank ACH/wire: Circle Mint mints USDC at par with no processor fee.
  bank_ach: { rate: 0, flatUsd: 0 },
  // FedNow/RTP instant rail: par mint, no processor cut.
  fednow: { rate: 0, flatUsd: 0 },
  // Card via Stripe Crypto Onramp, the "killer" cost, passed through 1:1.
  card: { rate: 0.029, flatUsd: 0.3 },
} as const;

/** Static descriptive metadata for each method. */
export type FundingMethodInfo = {
  readonly method: FundingMethod;
  readonly label: string;
  readonly description: string;
  readonly speed: FundingSpeed;
  /**
   * Whether this is the recommended default. Exactly one method is the default
   * (bank_ach) so the client never has to encode that policy itself.
   */
  readonly isDefault: boolean;
  /** Human-readable summary of the fee policy (not a computed amount). */
  readonly feeNote: string;
};

const METHOD_INFO: Record<FundingMethod, FundingMethodInfo> = {
  bank_ach: {
    method: "bank_ach",
    label: "Bank account (ACH)",
    description: "Free transfer from your bank. Arrives next business day.",
    speed: "next_day",
    isDefault: true,
    feeNote: "No fee",
  },
  fednow: {
    method: "fednow",
    label: "Instant bank (FedNow / RTP)",
    description: "Free instant transfer from a supported bank.",
    speed: "instant",
    isDefault: false,
    feeNote: "No fee",
  },
  card: {
    method: "card",
    label: "Debit or credit card",
    description: "Instant, but the card network fee is passed through.",
    speed: "instant",
    isDefault: false,
    feeNote: "2.9% + $0.30 card processing fee",
  },
} as const;

/** Ordered for display: default (bank) first, card last. */
export const FUNDING_METHOD_ORDER: readonly FundingMethod[] = [
  "bank_ach",
  "fednow",
  "card",
] as const;

/** The method the client should pre-select. */
export const DEFAULT_FUNDING_METHOD: FundingMethod = "bank_ach";

/** Round a USD amount to whole cents (avoids float drift on fee display). */
function roundCents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/**
 * Surcharge/fee charged for funding `amountUsd` via `method`, in USD.
 *
 * Card returns ~2.9% + $0.30 explicitly; bank rails return 0. This is the
 * fee the *user* pays on top of the amount they want to fund, it is NOT a
 * Talise margin (card fee is a pure pass-through of the processor cost).
 */
export function fundingFeeUsd(method: FundingMethod, amountUsd: number): number {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return 0;
  const spec = FEE_SPEC[method];
  return roundCents(amountUsd * spec.rate + spec.flatUsd);
}

/** Effective fee as a fraction of the funded amount, for "X% all-in" display. */
export function fundingFeeRate(method: FundingMethod, amountUsd: number): number {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return 0;
  return fundingFeeUsd(method, amountUsd) / amountUsd;
}

/** Full cost breakdown for funding `amountUsd` via `method`. */
export type FundingQuote = {
  readonly method: FundingMethod;
  /** USD the user wants delivered as USDC/USDsui. */
  readonly amountUsd: number;
  /** Fee in USD (pass-through for card, 0 for bank). */
  readonly feeUsd: number;
  /** Fee as a fraction of `amountUsd`, for display. */
  readonly feeRate: number;
  /** Total the user is charged: amount + fee. */
  readonly totalChargedUsd: number;
};

/** Build a per-method cost breakdown for a given funded amount. */
export function quoteFunding(
  method: FundingMethod,
  amountUsd: number
): FundingQuote {
  const safeAmount =
    Number.isFinite(amountUsd) && amountUsd > 0 ? roundCents(amountUsd) : 0;
  const feeUsd = fundingFeeUsd(method, safeAmount);
  return {
    method,
    amountUsd: safeAmount,
    feeUsd,
    feeRate: safeAmount > 0 ? feeUsd / safeAmount : 0,
    totalChargedUsd: roundCents(safeAmount + feeUsd),
  };
}

/** Static info for one method. */
export function fundingMethodInfo(method: FundingMethod): FundingMethodInfo {
  return METHOD_INFO[method];
}

/**
 * Methods + static info + (optionally) a cost breakdown for `amountUsd`,
 * in display order with the default first. The GET route serialises this.
 */
export function listFundingMethods(amountUsd?: number): Array<
  FundingMethodInfo & { quote?: FundingQuote }
> {
  return FUNDING_METHOD_ORDER.map((method) => {
    const info = METHOD_INFO[method];
    if (typeof amountUsd === "number" && Number.isFinite(amountUsd) && amountUsd > 0) {
      return { ...info, quote: quoteFunding(method, amountUsd) };
    }
    return { ...info };
  });
}
