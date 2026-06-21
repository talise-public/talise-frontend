import { describe, it, expect } from "vitest";
import {
  normalizeTier,
  isKycTier,
  limitsForTier,
  canUseCorridor,
  TIER_LIMITS,
  DEFAULT_TIER,
  MAX_TIER,
  KYC_TIERS,
} from "@/lib/kyc";

describe("kyc tier model", () => {
  it("normalizeTier collapses junk to the floor and clamps high values", () => {
    expect(normalizeTier(null)).toBe(0);
    expect(normalizeTier(undefined)).toBe(0);
    expect(normalizeTier("")).toBe(0);
    expect(normalizeTier(NaN)).toBe(0);
    expect(normalizeTier(-3)).toBe(0);
    expect(normalizeTier(0)).toBe(0);
    expect(normalizeTier(1)).toBe(1);
    expect(normalizeTier("2")).toBe(2);
    expect(normalizeTier(2.9)).toBe(2); // floored
    expect(normalizeTier(3)).toBe(3);
    expect(normalizeTier(99)).toBe(MAX_TIER); // clamped, never widens access
  });

  it("isKycTier only accepts the four modelled integers", () => {
    expect(isKycTier(0)).toBe(true);
    expect(isKycTier(3)).toBe(true);
    expect(isKycTier(4)).toBe(false);
    expect(isKycTier("1")).toBe(false);
    expect(isKycTier(1.5)).toBe(false);
  });

  it("every tier has a limit envelope and they are monotonic in send power", () => {
    for (const t of KYC_TIERS) {
      expect(limitsForTier(t).tier).toBe(t);
    }
    // Tier 0 cannot send; 1-3 can.
    expect(TIER_LIMITS[0].canSend).toBe(false);
    expect(TIER_LIMITS[1].canSend).toBe(true);
    // Monthly caps strictly increase (null = uncapped at the top).
    expect(TIER_LIMITS[1].monthlyUsd).toBeLessThan(TIER_LIMITS[2].monthlyUsd as number);
    expect(TIER_LIMITS[3].monthlyUsd).toBeNull();
    // Per-tx caps increase then go uncapped.
    expect(TIER_LIMITS[1].perTxUsd).toBeLessThan(TIER_LIMITS[2].perTxUsd as number);
    expect(TIER_LIMITS[3].perTxUsd).toBeNull();
  });

  it("DEFAULT_TIER is the email-only receive-only floor", () => {
    expect(DEFAULT_TIER).toBe(0);
    expect(TIER_LIMITS[DEFAULT_TIER].canReceive).toBe(true);
    expect(TIER_LIMITS[DEFAULT_TIER].canSend).toBe(false);
    expect(TIER_LIMITS[DEFAULT_TIER].corridorAccess).toBe("none");
  });
});

describe("canUseCorridor — single source of corridor-access truth", () => {
  it("tier 0 (none): no outbound, domestic or cross-border", () => {
    expect(canUseCorridor(0, true)).toBe(false);
    expect(canUseCorridor(0, false)).toBe(false);
  });
  it("tier 1 (domestic): same-country only", () => {
    expect(canUseCorridor(1, true)).toBe(true);
    expect(canUseCorridor(1, false)).toBe(false);
  });
  it("tiers 2 and 3 (all): every corridor", () => {
    expect(canUseCorridor(2, true)).toBe(true);
    expect(canUseCorridor(2, false)).toBe(true);
    expect(canUseCorridor(3, false)).toBe(true);
  });
});
