/**
 * On-ramp provider layer, public surface + env-driven selector.
 *
 * Mirrors web/lib/offramp/index.ts. The PRIMARY adapter is Bridge (persistent
 * virtual account: user wires fiat, Bridge mints on Sui straight to the user's
 * own address). The FALLBACK is Transak (hosted card widget). Select via
 * `ONRAMP_PROVIDER` (default `bridge`). BOTH deliver USDC on Sui today, so a
 * USDC → USDsui conversion finishes money-in either way.
 *
 * The single feature gate lives in `./flags` (`ONRAMP_ENABLED`, read at
 * REQUEST time so it can be flipped per-environment with no redeploy) and is
 * served to every client by `GET /api/onramp/config`. Nothing in here is
 * hard-coded off. The existing Stripe on-ramp routes
 * (app/api/onramp/session, app/api/onramp/hosted-session,
 * app/api/onramp/webhook) are untouched and live alongside these.
 */

export * from "./types";
export { computeRequirements, requiredTierForAmount, fieldsForTier } from "./requirements";
export { bridgeAdapter } from "./bridge";
export { transakAdapter } from "./transak";
export {
  isOnrampEnabled,
  onrampStatus,
  onrampSwitchOn,
  onrampProviderName,
  onrampProviderConfigured,
  type OnrampStatus,
  type OnrampClosedReason,
} from "./flags";

import type { OnrampProvider, OnrampProviderName } from "./types";
import { bridgeAdapter } from "./bridge";
import { transakAdapter } from "./transak";
import { onrampProviderName } from "./flags";

const ADAPTERS: Record<OnrampProviderName, OnrampProvider> = {
  bridge: bridgeAdapter,
  transak: transakAdapter,
};

/** Resolve the configured on-ramp provider, defaulting to Bridge. */
export function getOnrampProvider(): OnrampProvider {
  return ADAPTERS[onrampProviderName()];
}

/** Resolve a specific provider by name (e.g. to force the fallback). */
export function getProviderByName(name: OnrampProviderName): OnrampProvider {
  return ADAPTERS[name];
}
