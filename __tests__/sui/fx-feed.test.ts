import { describe, it, expect } from "vitest";
import { volTier, corridorSpreadBps } from "@/lib/fx-feed";
import { isCurrency, ALL_CURRENCIES } from "@/lib/fx";

describe("fx-feed corridor spread (pure)", () => {
  it("same-currency corridor has zero spread", () => {
    expect(corridorSpreadBps("USD", "USD")).toBe(0);
    expect(corridorSpreadBps("NGN", "NGN")).toBe(0);
  });

  it("corridor spread is the MAX of the two legs' volatility tiers", () => {
    // A stable<->high corridor must price at the high-tier spread, not the
    // average — the riskier leg sets the floor.
    const usdNgn = corridorSpreadBps("USD", "NGN");
    const usdUsd = corridorSpreadBps("USD", "USD");
    expect(usdNgn).toBeGreaterThan(usdUsd);
    // symmetry: direction doesn't change the spread
    expect(corridorSpreadBps("NGN", "USD")).toBe(corridorSpreadBps("USD", "NGN"));
  });

  it("volTier classifies every supported currency", () => {
    for (const c of ALL_CURRENCIES) {
      expect(["stable", "mid", "high"]).toContain(volTier(c));
    }
  });

  it("a high-volatility currency prices wider than a stable one", () => {
    // VND/NGN (emerging) should not be cheaper to convert than SGD (stable).
    expect(corridorSpreadBps("USD", "VND")).toBeGreaterThanOrEqual(
      corridorSpreadBps("USD", "SGD")
    );
  });
});

describe("fx currency type expansion", () => {
  it("recognizes the new Asian corridor currencies", () => {
    for (const c of ["JPY", "SGD", "PHP", "IDR", "VND"]) {
      expect(isCurrency(c)).toBe(true);
    }
  });
  it("keeps the original African + USD currencies", () => {
    for (const c of ["NGN", "KES", "GHS", "ZAR", "USD"]) {
      expect(isCurrency(c)).toBe(true);
    }
  });
  it("rejects non-currencies", () => {
    expect(isCurrency("XYZ")).toBe(false);
    expect(isCurrency("")).toBe(false);
    expect(isCurrency(123)).toBe(false);
  });
});
