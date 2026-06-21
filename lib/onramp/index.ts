/**
 * On-ramp provider layer — public surface + env-driven selector.
 *
 * Mirrors web/lib/offramp/index.ts. The PRIMARY adapter is Bridge (delivers
 * USDsui directly on Sui, since Bridge issues the Sui Dollar). The FALLBACK
 * is Transak (delivers USDC on Sui, then a swap-to-USDsui step). Select via
 * `ONRAMP_PROVIDER` (default `bridge`).
 *
 * Everything here is additive scaffolding. The whole feature is dormant
 * behind `NEXT_PUBLIC_ONRAMP_ENABLED` and is NOT wired into primary nav or
 * any send/balance/limit path. The existing Stripe-based on-ramp routes
 * (app/api/onramp/session, app/api/onramp/webhook) are untouched and remain
 * the live path; these provider-agnostic routes live alongside them.
 */

export * from "./types";
export { computeRequirements, requiredTierForAmount, fieldsForTier } from "./requirements";
export { bridgeAdapter } from "./bridge";
export { transakAdapter } from "./transak";

import type { OnrampProvider, OnrampProviderName } from "./types";
import { bridgeAdapter } from "./bridge";
import { transakAdapter } from "./transak";

const ADAPTERS: Record<OnrampProviderName, OnrampProvider> = {
  bridge: bridgeAdapter,
  transak: transakAdapter,
};

/** Resolve the configured on-ramp provider, defaulting to Bridge. */
export function getOnrampProvider(): OnrampProvider {
  const raw = (process.env.ONRAMP_PROVIDER || "bridge").toLowerCase();
  const name: OnrampProviderName = raw === "transak" ? "transak" : "bridge";
  return ADAPTERS[name];
}

/** Resolve a specific provider by name (e.g. to force the fallback). */
export function getProviderByName(name: OnrampProviderName): OnrampProvider {
  return ADAPTERS[name];
}

/** Whether the on-ramp feature is enabled (server-readable mirror of the flag). */
export function isOnrampEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ONRAMP_ENABLED === "true";
}
