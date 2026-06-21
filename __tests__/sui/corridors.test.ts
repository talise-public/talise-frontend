import { describe, it, expect } from "vitest";
import {
  CORRIDORS,
  listCorridors,
  getCorridor,
  isCorridorLive,
  isCorridorBookable,
  corridorAccessForTier,
} from "@/lib/corridors";

describe("corridor registry — African + Asian merge", () => {
  it("registers the live African beachhead (US->NG) and partner Asian corridors", () => {
    const usNg = getCorridor("US", "NG");
    expect(usNg?.status).toBe("live");
    expect(usNg?.toCcy).toBe("NGN");
    expect(isCorridorLive("US", "NG")).toBe(true);

    const usJp = getCorridor("US", "JP");
    expect(usJp).toBeTruthy();
    expect(usJp?.toCcy).toBe("JPY");
    // JP corridor carries the partner-rail per-tx cap (¥1M-equivalent).
    expect(usJp?.perTxCapUsd).toBeGreaterThan(0);
  });

  it("planned corridors are not live and not bookable; partner corridors are bookable but not live", () => {
    const planned = CORRIDORS.find((c) => c.status === "planned");
    if (planned) {
      expect(isCorridorLive(planned.fromCountry, planned.toCountry)).toBe(false);
      expect(isCorridorBookable(planned)).toBe(false);
    }
    const partner = CORRIDORS.find((c) => c.status === "partner");
    if (partner) {
      expect(isCorridorBookable(partner)).toBe(true);
      expect(isCorridorLive(partner.fromCountry, partner.toCountry)).toBe(false);
    }
  });

  it("cross-currency corridors carry a positive spread; same-currency is zero", () => {
    for (const c of listCorridors()) {
      expect(c.fromCcy).toBeTruthy();
      expect(c.toCcy).toBeTruthy();
      expect(c.spreadBps).toBeGreaterThanOrEqual(0);
      if (c.fromCcy !== c.toCcy) {
        // A real FX conversion must capture spread; a same-currency
        // (domestic, e.g. US->US) corridor legitimately charges none.
        expect(c.spreadBps).toBeGreaterThan(0);
      }
    }
  });

  it("corridorAccessForTier gates cross-border on tier-2+ and domestic on tier-1", () => {
    const crossBorder = CORRIDORS.find((c) => c.fromCountry !== c.toCountry)!;
    // Tier 0 = no outbound; Tier 1 = domestic only; Tier 2/3 = all.
    expect(corridorAccessForTier(crossBorder, 0)).toBe(false);
    expect(corridorAccessForTier(crossBorder, 1)).toBe(false); // cross-border blocked at tier 1
    expect(corridorAccessForTier(crossBorder, 2)).toBe(true);
    expect(corridorAccessForTier(crossBorder, 3)).toBe(true);
  });
});
