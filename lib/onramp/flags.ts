import "server-only";

import { bridgeConfigured } from "@/lib/bridge/client";
import type { OnrampProviderName } from "./types";

/**
 * THE single source of truth for whether Talise's fiat on-ramp is open.
 *
 * Every client reads the same verdict:
 *   • web      , `/app/ramps` fetches `GET /api/onramp/config`
 *   • iOS      , `RampFlagsStore` fetches `GET /api/onramp/config`
 *   • Android  , `OnrampApi.config()` fetches `GET /api/onramp/config`
 *   • server   , `isOnrampEnabled()` guards `/api/onramp/v2/*`
 *
 * There is no hard-coded `false` anywhere. Flipping the env var flips every
 * surface with NO redeploy, because the flag is read at REQUEST time from a
 * server-only var (not a build-inlined `NEXT_PUBLIC_*`).
 *
 * ── Env ──────────────────────────────────────────────────────────────
 *   ONRAMP_ENABLED=true            master switch (default false → OFF)
 *   ONRAMP_PROVIDER=bridge|transak active adapter (default bridge)
 *   BRIDGE_API_KEY=…               REQUIRED for `bridge` to be usable
 *   TRANSAK_API_KEY=…              REQUIRED for `transak` to be usable
 *
 * `NEXT_PUBLIC_ONRAMP_ENABLED` is still honoured as a LEGACY alias so an
 * environment already carrying it keeps working, but prefer `ONRAMP_ENABLED`.
 *
 * ── Fail closed ──────────────────────────────────────────────────────
 * `enabled` is true only when the switch is on AND the selected provider has
 * real credentials. The adapters fall back to deterministic STUB data when
 * unkeyed (fake `widgetUrl`, derived customer ids); shipping that to a user
 * who is trying to fund an account would be a lie that costs them money, so
 * an unconfigured provider reads as OFF, never as "open with a stub".
 */

/** `true` only for the exact string "true" (after trim/lowercase). */
function truthy(v: string | undefined): boolean {
  return (v ?? "").trim().toLowerCase() === "true";
}

/** Master switch, independent of whether the provider is actually usable. */
export function onrampSwitchOn(): boolean {
  return (
    truthy(process.env.ONRAMP_ENABLED) ||
    // Legacy alias, kept so existing environments don't silently regress.
    truthy(process.env.NEXT_PUBLIC_ONRAMP_ENABLED)
  );
}

/** The configured provider name (default `bridge`). */
export function onrampProviderName(): OnrampProviderName {
  return (process.env.ONRAMP_PROVIDER || "bridge").trim().toLowerCase() ===
    "transak"
    ? "transak"
    : "bridge";
}

/** Whether the selected provider has the credentials it needs to be real. */
export function onrampProviderConfigured(
  provider: OnrampProviderName = onrampProviderName()
): boolean {
  return provider === "transak"
    ? !!process.env.TRANSAK_API_KEY
    : bridgeConfigured();
}

/**
 * Why the on-ramp is closed, or `null` when it's open. Machine-readable so the
 * clients can render honest, specific copy instead of a generic "soon".
 */
export type OnrampClosedReason = "switch_off" | "provider_unconfigured";

export type OnrampStatus = {
  /** The only field a client should branch its primary flow on. */
  enabled: boolean;
  provider: OnrampProviderName;
  /** Provider credentials present. */
  configured: boolean;
  closedReason: OnrampClosedReason | null;
  /**
   * Funding shape the enabled provider uses, so clients can pick the right UI
   * without knowing provider names: `bank` = persistent account/IBAN to wire
   * to (Bridge virtual account); `widget` = hosted checkout redirect (Transak).
   */
  funding: "bank" | "widget";
  /**
   * The asset that actually lands on the user's Sui address. Bridge delivers
   * USDC on Sui (per BRIDGE_SUI_CURRENCY), NOT USDsui, so clients must not
   * promise "arrives as USDsui" without the conversion step.
   */
  deliverAsset: "USDSUI" | "USDC";
  /** True when a USDC → USDsui conversion is needed after funds land. */
  requiresSwapToUsdsui: boolean;
};

/** Resolve the full on-ramp status. Pure env read, safe to call per request. */
export function onrampStatus(): OnrampStatus {
  const provider = onrampProviderName();
  const configured = onrampProviderConfigured(provider);
  const switchOn = onrampSwitchOn();
  const closedReason: OnrampClosedReason | null = !switchOn
    ? "switch_off"
    : !configured
      ? "provider_unconfigured"
      : null;
  return {
    enabled: closedReason === null,
    provider,
    configured,
    closedReason,
    funding: provider === "bridge" ? "bank" : "widget",
    // Both live adapters land USDC on Sui today (BRIDGE_SUI_CURRENCY = "usdc").
    deliverAsset: "USDC",
    requiresSwapToUsdsui: true,
  };
}

/** Whether the on-ramp feature is open. The server-side gate for `/v2/*`. */
export function isOnrampEnabled(): boolean {
  return onrampStatus().enabled;
}
