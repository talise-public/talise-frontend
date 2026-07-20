import "server-only";

import { db, ensureSchema } from "@/lib/db";

/**
 * Talise KYC tier engine (cross-border master plan §7, compliance P0).
 *
 * A four-tier model gates how much value a user can move and which
 * corridors they can use, scaled to the strength of identity evidence
 * they've cleared. Tier is persisted as `users.kyc_tier` (INTEGER,
 * default 0); see web/lib/db.ts ensureSchema.
 *
 *   Tier 0, email-only. Can RECEIVE into the wallet, can hold a
 *            balance, but cannot send/off-ramp. This is the implicit
 *            floor for every account the moment it's created via
 *            zkLogin: an email exists, nothing else is verified.
 *
 *   Tier 1, basic ID. A single government-ID document check (the
 *            cheapest eKYC pass). Unlocks low-value sending, roughly
 *            ~$1k/month, enough for day-to-day remittance test drives
 *            without triggering enhanced-diligence obligations.
 *
 *   Tier 2, full ID + proof of address + a clean sanctions/PEP
 *            screen. Unlocks the headline cross-border corridors at
 *            their full per-tx / monthly limits.
 *
 *   Tier 3, enhanced due diligence (EDD): documented source of funds
 *            on top of everything in tier 2. For high-value users; the
 *            limits here are "effectively uncapped" relative to retail
 *            flow and reviewed case-by-case.
 *
 * This module is the single source of truth for the tier model and its
 * limits. It is deliberately NOT wired into the send path yet, the send
 * pipeline (web/app/api/send/sponsor-prepare/route.ts) is untouched. The
 * limits are exposed so the UI and a future enforcement layer can read
 * one consistent table.
 *
 * NOTE: all monetary figures are USD. USDsui settles 1:1 with USD, so a
 * USD limit maps directly onto a USDsui amount with no conversion.
 */

export type KycTier = 0 | 1 | 2 | 3;

export const KYC_TIERS: readonly KycTier[] = [0, 1, 2, 3];

/** The floor tier assigned to every account that hasn't verified anything. */
export const DEFAULT_TIER: KycTier = 0;

/** The strongest tier we model. */
export const MAX_TIER: KycTier = 3;

/**
 * Per-tier limit envelope, all amounts in USD.
 *
 *   canReceive     , may funds land in this user's wallet?
 *   canSend        , may this user initiate an outbound transfer?
 *   perTxUsd       , max value of a single send (null = no cap).
 *   monthlyUsd     , rolling 30-day outbound cap (null = no cap).
 *   corridorAccess , which corridors this tier may use. "none" = no
 *                      outbound; "domestic" = same-country only;
 *                      "all" = every supported cross-border corridor.
 *   sanctionsCleared, does reaching this tier require a clean
 *                      sanctions/PEP screen? (informational; the actual
 *                      screen runs in the eKYC flow.)
 *   sourceOfFunds  , does this tier require documented source of funds
 *                      (EDD)?
 */
export type TierLimits = {
  tier: KycTier;
  label: string;
  description: string;
  canReceive: boolean;
  canSend: boolean;
  perTxUsd: number | null;
  monthlyUsd: number | null;
  corridorAccess: "none" | "domestic" | "all";
  sanctionsCleared: boolean;
  sourceOfFunds: boolean;
};

export const TIER_LIMITS: Readonly<Record<KycTier, TierLimits>> = {
  0: {
    tier: 0,
    label: "Email only",
    description: "Receive only. Verify your identity to start sending.",
    canReceive: true,
    canSend: false,
    perTxUsd: 0,
    monthlyUsd: 0,
    corridorAccess: "none",
    sanctionsCleared: false,
    sourceOfFunds: false,
  },
  1: {
    tier: 1,
    label: "Basic ID",
    description: "Government ID verified. Low-value sending unlocked.",
    canReceive: true,
    canSend: true,
    perTxUsd: 250,
    monthlyUsd: 1_000,
    corridorAccess: "domestic",
    sanctionsCleared: false,
    sourceOfFunds: false,
  },
  2: {
    tier: 2,
    label: "Full ID + address",
    description:
      "ID, proof of address, and sanctions screen cleared. Full corridor access.",
    canReceive: true,
    canSend: true,
    perTxUsd: 5_000,
    monthlyUsd: 25_000,
    corridorAccess: "all",
    sanctionsCleared: true,
    sourceOfFunds: false,
  },
  3: {
    tier: 3,
    label: "Enhanced (EDD)",
    description:
      "Source of funds documented. High-value transfers, reviewed case-by-case.",
    canReceive: true,
    canSend: true,
    perTxUsd: null,
    monthlyUsd: null,
    corridorAccess: "all",
    sanctionsCleared: true,
    sourceOfFunds: true,
  },
};

/** Type guard: is `n` one of the modelled tier integers? */
export function isKycTier(n: unknown): n is KycTier {
  return n === 0 || n === 1 || n === 2 || n === 3;
}

/**
 * Normalize an arbitrary stored value into a valid tier. NULL, undefined,
 * out-of-range, and non-integers all collapse to the floor (0). Values
 * above MAX_TIER clamp to MAX_TIER so a corrupt high value never widens
 * access beyond what we model.
 */
export function normalizeTier(raw: unknown): KycTier {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(n)) return DEFAULT_TIER;
  const floored = Math.floor(n);
  if (floored <= 0) return DEFAULT_TIER;
  if (floored >= MAX_TIER) return MAX_TIER;
  return floored as KycTier;
}

/** Look up the limit envelope for a tier. */
export function limitsForTier(tier: KycTier): TierLimits {
  return TIER_LIMITS[tier];
}

/**
 * Single source of truth for corridor-access gating. Given a tier and
 * whether the transfer is same-country (domestic) or cross-border, return
 * whether the corridor is permitted. The send / corridor layers consume
 * THIS rather than re-deriving access from `corridorAccess` strings, so
 * the policy lives in one place.
 *
 *   none     → no outbound at all
 *   domestic → same-country transfers only
 *   all      → every supported corridor
 */
export function canUseCorridor(tier: KycTier, sameCountry: boolean): boolean {
  const access = TIER_LIMITS[tier].corridorAccess;
  if (access === "all") return true;
  if (access === "domestic") return sameCountry;
  return false;
}

/**
 * Read the persisted tier for a user. Returns 0 when the row is missing
 * or the column is NULL, i.e. unverified accounts (and any account that
 * predates the column) read as the email-only floor.
 */
export async function getUserTier(userId: number): Promise<KycTier> {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT kyc_tier FROM users WHERE id = ? LIMIT 1",
    args: [userId],
  });
  if (r.rows.length === 0) return DEFAULT_TIER;
  return normalizeTier(r.rows[0]?.kyc_tier);
}

/** Convenience: tier + its limit envelope in one read. */
export async function getUserTierWithLimits(
  userId: number
): Promise<{ tier: KycTier; limits: TierLimits }> {
  const tier = await getUserTier(userId);
  return { tier, limits: limitsForTier(tier) };
}

/**
 * Persist a new tier for a user. Idempotent. This is the write path a
 * post-verification webhook (or admin action) would call once eKYC
 * returns `approved`. It is intentionally separate from the POST route's
 * "intent" recording so that recording an upgrade request never silently
 * grants the tier, promotion is an explicit, reviewed step.
 */
export async function setUserTier(
  userId: number,
  tier: KycTier
): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: "UPDATE users SET kyc_tier = ? WHERE id = ?",
    args: [tier, userId],
  });
}
