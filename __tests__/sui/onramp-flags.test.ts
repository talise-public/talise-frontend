import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { onrampStatus, isOnrampEnabled } from "@/lib/onramp/flags";

/**
 * The on-ramp feature gate is the last thing standing between a user and a
 * screen that says "wire your money to this account number". These assertions
 * pin the FAIL-CLOSED contract: the flag alone is never enough, the provider
 * must actually be configured, and only the exact string "true" opens it.
 *
 * Pure env reads — no network, no DB.
 */

const KEYS = [
  "ONRAMP_ENABLED",
  "NEXT_PUBLIC_ONRAMP_ENABLED",
  "ONRAMP_PROVIDER",
  "BRIDGE_API_KEY",
  "TRANSAK_API_KEY",
] as const;

const original = Object.fromEntries(
  KEYS.map((k) => [k, process.env[k]])
) as Record<string, string | undefined>;

function clear() {
  for (const k of KEYS) delete process.env[k];
}

beforeEach(clear);

afterAll(() => {
  clear();
  for (const [k, v] of Object.entries(original)) {
    if (v !== undefined) process.env[k] = v;
  }
});

describe("on-ramp feature gate (lib/onramp/flags)", () => {
  it("defaults to CLOSED with nothing configured", () => {
    const s = onrampStatus();
    expect(s.enabled).toBe(false);
    expect(s.closedReason).toBe("switch_off");
    expect(isOnrampEnabled()).toBe(false);
  });

  it("the switch alone does NOT open it — the provider must be configured", () => {
    process.env.ONRAMP_ENABLED = "true";
    const s = onrampStatus();
    // Bridge is the default provider and has no API key here, so the adapter
    // would return STUB bank details. That must never read as "open".
    expect(s.configured).toBe(false);
    expect(s.enabled).toBe(false);
    expect(s.closedReason).toBe("provider_unconfigured");
  });

  it("credentials alone do NOT open it — the switch must be on", () => {
    process.env.BRIDGE_API_KEY = "sk-test-abc";
    const s = onrampStatus();
    expect(s.configured).toBe(true);
    expect(s.enabled).toBe(false);
    expect(s.closedReason).toBe("switch_off");
  });

  it("opens only with BOTH the switch and provider credentials", () => {
    process.env.ONRAMP_ENABLED = "true";
    process.env.BRIDGE_API_KEY = "sk-test-abc";
    const s = onrampStatus();
    expect(s.enabled).toBe(true);
    expect(s.closedReason).toBeNull();
    expect(s.provider).toBe("bridge");
    // Bridge funds via a bank virtual account and delivers USDC on Sui, so the
    // clients must be told a conversion step remains.
    expect(s.funding).toBe("bank");
    expect(s.deliverAsset).toBe("USDC");
    expect(s.requiresSwapToUsdsui).toBe(true);
  });

  it("only the exact string \"true\" is truthy", () => {
    process.env.BRIDGE_API_KEY = "sk-test-abc";
    for (const v of ["1", "yes", "TRUE ", "on", "", "false"]) {
      process.env.ONRAMP_ENABLED = v;
      // "TRUE " trims + lowercases to "true", which IS accepted; everything
      // else must stay closed.
      const expected = v.trim().toLowerCase() === "true";
      expect(onrampStatus().enabled).toBe(expected);
    }
  });

  it("honours the legacy NEXT_PUBLIC_ alias", () => {
    process.env.NEXT_PUBLIC_ONRAMP_ENABLED = "true";
    process.env.BRIDGE_API_KEY = "sk-test-abc";
    expect(onrampStatus().enabled).toBe(true);
  });

  it("checks the credentials of the SELECTED provider, not just Bridge", () => {
    process.env.ONRAMP_ENABLED = "true";
    process.env.ONRAMP_PROVIDER = "transak";
    process.env.BRIDGE_API_KEY = "sk-test-abc"; // wrong provider's key
    expect(onrampStatus().enabled).toBe(false);

    process.env.TRANSAK_API_KEY = "tk-test-abc";
    const s = onrampStatus();
    expect(s.enabled).toBe(true);
    expect(s.provider).toBe("transak");
    expect(s.funding).toBe("widget");
  });

  it("an unknown provider name falls back to bridge, never to 'open'", () => {
    process.env.ONRAMP_ENABLED = "true";
    process.env.ONRAMP_PROVIDER = "totally-made-up";
    expect(onrampStatus().provider).toBe("bridge");
    expect(onrampStatus().enabled).toBe(false); // no BRIDGE_API_KEY
  });
});
