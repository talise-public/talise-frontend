/**
 * Provider-agnostic ON-RAMP interface (additive scaffold).
 *
 * Talise's base asset USDsui is the "Sui Dollar," issued by Bridge (a Stripe
 * company). So the PRIMARY on-ramp adapter delivers USDsui directly on Sui via
 * Bridge; a card-supporting aggregator (Transak) is the FALLBACK that delivers
 * USDC on Sui, which the existing AutoConvertBanner then sweeps to USDsui.
 *
 * This mirrors the shape of the off-ramp layer (web/lib/offramp/*): ONE
 * internal interface, swappable adapters, a registry/selector. Adapters own
 * NO persistence and NO on-chain logic — the API routes + DB do.
 *
 * KYC is TIERED and dynamic per country:
 *   none      — nothing verified
 *   lite      — name/email/mobile/country/address (no ID document)
 *   standard  — lite + government ID + selfie/liveness + purpose of usage
 *               (+ SSN when country = US)
 *   enhanced  — standard + proof of address + source of funds
 *
 * NOTE: every adapter here is a STUB. With no API key set it returns
 * deterministic, typed mock data so the routes + modal can be wired and
 * tested end-to-end. Each real call site is marked with a `// TODO(live):`.
 */

/** The on-ramp KYC tier ladder. Ordered weakest → strongest. */
export type OnrampKycTier = "none" | "lite" | "standard" | "enhanced";

/** Ordered tiers, so callers can compare strength without a map. */
export const ONRAMP_TIERS: readonly OnrampKycTier[] = [
  "none",
  "lite",
  "standard",
  "enhanced",
];

/** Numeric rank of a tier (none=0 … enhanced=3) for ≥ / max comparisons. */
export function tierRank(tier: OnrampKycTier): number {
  return ONRAMP_TIERS.indexOf(tier);
}

/** Provider identifiers. `bridge` is the default; `transak` is the fallback. */
export type OnrampProviderName = "bridge" | "transak";

/** Verification lifecycle, persisted on `onramp_kyc.status`. */
export type OnrampKycStatus =
  | "unverified"
  | "pending"
  | "approved"
  | "rejected"
  | "expired";

/** The asset an adapter can deliver to the user's Sui address. */
export type DeliverAsset = "USDSUI" | "USDC";

/**
 * The discrete KYC fields the flow can ask for. The requirements engine
 * returns the SUBSET still missing for a given purchase, so the modal only
 * renders what the amount/country actually require.
 */
export type KycField =
  | "firstName"
  | "lastName"
  | "email"
  | "mobile"
  | "country"
  | "address.line1"
  | "address.city"
  | "address.region"
  | "address.postalCode"
  | "governmentId"
  | "selfie"
  | "purposeOfUsage"
  | "ssn" // US only, standard+
  | "proofOfAddress" // enhanced
  | "sourceOfFunds"; // enhanced

/** A postal address. Collected from `lite` upward. */
export interface KycAddress {
  line1: string;
  city: string;
  region: string;
  postalCode: string;
}

/** Applicant profile the client collects, shaped to span all tiers. */
export interface KycProfile {
  firstName: string;
  lastName: string;
  email: string;
  mobile?: string;
  country: string;
  address?: KycAddress;
  /** standard+: opaque upload references for the ID document + selfie. */
  governmentIdRef?: string;
  selfieRef?: string;
  purposeOfUsage?: string;
  /** US + standard+. */
  ssn?: string;
  /** enhanced. */
  proofOfAddressRef?: string;
  sourceOfFunds?: string;
}

/** Input to {@link OnrampProvider.getRequirements}. */
export interface RequirementsInput {
  /** Purchase size in USD cents. Drives which tier the amount needs. */
  amountCents: number;
  /** ISO 3166-1 alpha-2. KYC requirements are dynamic per country. */
  country: string;
  /** The tier the user has already cleared (so we only ask for the delta). */
  currentTier: OnrampKycTier;
}

/** Result of {@link OnrampProvider.getRequirements}. */
export interface RequirementsResult {
  /** The minimum tier this purchase requires. */
  requiredTier: OnrampKycTier;
  /** Fields still missing to reach `requiredTier` from `currentTier`. */
  missingFields: KycField[];
  /** Whether the current tier already satisfies the purchase. */
  satisfied: boolean;
  /** Optional per-tier limits the provider advertises, USD cents. */
  dailyLimitCents?: number | null;
  monthlyLimitCents?: number | null;
}

/** Result of {@link OnrampProvider.createOrUpdateCustomer}. */
export interface CustomerResult {
  providerCustomerId: string;
  status: OnrampKycStatus;
  /** Limits the provider granted at this tier, if known (USD cents). */
  dailyLimitCents?: number | null;
  monthlyLimitCents?: number | null;
  /**
   * Bridge (and other API-driven KYC providers): a HOSTED KYC + ToS URL to
   * redirect the user to. Widget providers that run KYC inside their funding
   * widget (Transak) leave this unset.
   */
  kycUrl?: string;
}

/** Input to {@link OnrampProvider.createOnrampSession}. */
export interface SessionInput {
  providerCustomerId: string;
  amountCents: number;
  /** The locked destination Sui address funds are delivered to. */
  destinationAddress: string;
  /** USDSUI (Bridge, direct) or USDC (Transak, then swap to USDsui). */
  deliverAsset: DeliverAsset;
  /**
   * Funding fiat currency, lowercase ISO ("usd" | "eur" | "gbp" | …). Bridge
   * uses it to pick the virtual-account rail (a EUR user funds a SEPA account,
   * not a USD one). Defaults to "usd" when unset.
   */
  sourceCurrency?: string;
}

/**
 * Result of {@link OnrampProvider.createOnrampSession}. Exactly one of
 * `widgetUrl` / `clientSecret` is populated, depending on whether the
 * provider hands off via a hosted URL or an embedded SDK secret.
 */
export interface SessionResult {
  provider: OnrampProviderName;
  /** Hosted widget URL (redirect / iframe flows). */
  widgetUrl?: string;
  /** Embedded-SDK client secret (in-page flows). */
  clientSecret?: string;
  /** The asset that will land on `destinationAddress`. */
  deliverAsset: DeliverAsset;
  /**
   * Transak only: USDC is delivered, then a swap-to-USDsui step is required.
   * `true` tells the caller the on-chain leg isn't USDsui yet.
   */
  requiresSwapToUsdsui: boolean;
  /**
   * Bridge: bank-deposit coordinates the user funds to mint USDsui (a virtual
   * account isn't a redirect widget). Present instead of `widgetUrl` for the
   * deposit-instructions funding model. One of `widgetUrl` / `clientSecret` /
   * `depositInstructions` is populated.
   */
  depositInstructions?: {
    currency: string;
    paymentRails?: string[];
    bankName?: string;
    /** Receiving bank's mailing address (some sending forms require it). */
    bankAddress?: string;
    accountNumber?: string;
    routingNumber?: string;
    /** "checking" | "savings" — Bridge USD virtual accounts are checking. */
    accountType?: string;
    beneficiaryName?: string;
    /** Account holder's address — sending forms ask for recipient address. */
    beneficiaryAddress?: string;
    iban?: string;
    bic?: string;
    depositMessage?: string;
  };
}

/** A normalized, typed webhook event after verification. */
export interface OnrampWebhookEvent {
  provider: OnrampProviderName;
  /** Whether the signature/HMAC verified. */
  verified: boolean;
  /** Coarse event kind we care about. */
  kind: "kyc.updated" | "onramp.completed" | "unknown";
  providerCustomerId?: string;
  status?: OnrampKycStatus;
  tier?: OnrampKycTier;
  country?: string;
  dailyLimitCents?: number | null;
  monthlyLimitCents?: number | null;
  /** Raw decoded payload for logging/debug. */
  raw: unknown;
}

/**
 * The one interface every on-ramp provider implements. Stub implementations
 * return deterministic mock data when no API key is configured.
 */
export interface OnrampProvider {
  /** Stable id, e.g. "bridge". */
  readonly name: OnrampProviderName;
  /** Human label for logs/admin. */
  readonly displayName: string;
  /** What this adapter delivers on-chain. */
  readonly deliverAsset: DeliverAsset;
  /**
   * True when the provider's HOSTED WIDGET performs KYC itself (e.g. Transak,
   * MoonPay) — Talise collects no identity fields up front; the widget asks
   * for whatever the amount/country requires. The session route then skips
   * Talise-side profile collection and derives a stable partner reference from
   * the authenticated user. Bridge (API-driven KYC) leaves this false/unset.
   */
  readonly widgetCollectsKyc?: boolean;

  /** Quote-gated KYC: which tier + fields does this purchase need? */
  getRequirements(input: RequirementsInput): Promise<RequirementsResult>;

  /** Create or update the provider-side customer from a collected profile. */
  createOrUpdateCustomer(profile: KycProfile): Promise<CustomerResult>;

  /** Create a funding session; returns a widget URL or client secret. */
  createOnrampSession(input: SessionInput): Promise<SessionResult>;

  /** Verify + parse an inbound webhook into a typed event. */
  verifyWebhook(
    rawBody: string,
    headers: Headers | Record<string, string>
  ): Promise<OnrampWebhookEvent>;
}
