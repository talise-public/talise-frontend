/**
 * Quote-gated KYC requirements engine (provider-agnostic).
 *
 * Maps a purchase (amount in USD cents + country) onto the minimum on-ramp
 * KYC tier, and computes the field DELTA still missing from the user's
 * current tier. Both the Bridge and Transak adapters reuse this so the tier
 * ladder lives in ONE place; an adapter only overrides it if a provider's
 * thresholds differ.
 *
 * Thresholds (USD): these are conservative scaffold defaults, NOT a
 * compliance-reviewed table, tune per provider/jurisdiction before live.
 *   < $100        → lite
 *   $100 – $1,000 → standard
 *   > $1,000      → enhanced
 *
 * Country dynamics modelled here: US standard+ additionally requires an SSN.
 */

import {
  type KycField,
  type OnrampKycTier,
  type RequirementsInput,
  type RequirementsResult,
  tierRank,
} from "./types";

/** USD thresholds (cents) at which a stronger tier kicks in. */
const STANDARD_THRESHOLD_CENTS = 100_00; // $100
const ENHANCED_THRESHOLD_CENTS = 1_000_00; // $1,000

/** Map a purchase amount to the minimum required tier. */
export function requiredTierForAmount(amountCents: number): OnrampKycTier {
  if (amountCents > ENHANCED_THRESHOLD_CENTS) return "enhanced";
  if (amountCents >= STANDARD_THRESHOLD_CENTS) return "standard";
  if (amountCents > 0) return "lite";
  return "none";
}

/** The cumulative fields a tier requires, for a given country. */
export function fieldsForTier(
  tier: OnrampKycTier,
  country: string
): KycField[] {
  const isUS = country.trim().toUpperCase() === "US";

  const lite: KycField[] = [
    "firstName",
    "lastName",
    "email",
    "mobile",
    "country",
    "address.line1",
    "address.city",
    "address.region",
    "address.postalCode",
  ];

  const standard: KycField[] = [
    ...lite,
    "governmentId",
    "selfie",
    "purposeOfUsage",
    ...(isUS ? (["ssn"] as KycField[]) : []),
  ];

  const enhanced: KycField[] = [
    ...standard,
    "proofOfAddress",
    "sourceOfFunds",
  ];

  switch (tier) {
    case "none":
      return [];
    case "lite":
      return lite;
    case "standard":
      return standard;
    case "enhanced":
      return enhanced;
  }
}

/**
 * Compute the requirements for a purchase: the required tier and the fields
 * still missing relative to the user's current tier. If the current tier
 * already meets the requirement, `satisfied` is true and `missingFields` is
 * empty.
 */
export function computeRequirements(
  input: RequirementsInput
): RequirementsResult {
  const requiredTier = requiredTierForAmount(input.amountCents);
  const satisfied = tierRank(input.currentTier) >= tierRank(requiredTier);

  const have = new Set(fieldsForTier(input.currentTier, input.country));
  const need = fieldsForTier(requiredTier, input.country);
  const missingFields = satisfied ? [] : need.filter((f) => !have.has(f));

  return { requiredTier, missingFields, satisfied };
}
