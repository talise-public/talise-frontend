import "server-only";

/**
 * Corridor registry: destination currency → ORDERED payout providers.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * This file used to be `toCcy → one PayoutAdapter`, where every non-NGN entry
 * was a mock. Two problems, both of which cost real money in the failure case:
 *
 *  1. A corridor could not express "primary and fallback". With one adapter per
 *     currency, a provider incident IS a corridor outage; there is nowhere for
 *     traffic to go and no way to shift it without a deploy.
 *
 *  2. `hasAdapter("KES")` returned TRUE and `adapterForCurrency("KES")` returned
 *     a mock whose `status()` reports "pending" forever. Any caller that wired
 *     this up would tell a user their payout was in progress when no partner had
 *     ever been contacted. Stub adapters are now explicitly NOT usable in
 *     production (see `config.stubsAllowed`), and resolution reports WHY.
 *
 * NGN is no longer "reserved and invisible". It is a normal corridor served by a
 * registered `linq` provider, so it participates in health, circuit breaking and
 * diagnostics like every other rail. The live `app/api/offramp/linq/*` routes
 * keep their bespoke deposit-address choreography (Linq's model is unusual, see
 * `linq-provider.ts`), but they now consult the SAME health/gating layer, so a
 * dead Linq stops the corridor before the user sends funds instead of after.
 */

import { linqProvider } from "./linq-provider";
import { bridgeProvider } from "./bridge-provider";
import { paynowSgAdapter } from "./paynow-sg";
import { zenginJpAdapter } from "./zengin-jp";
import { mpesaKeAdapter } from "./mpesa-ke";
import { makeGenericBankAdapter } from "./generic-bank";
import { corridorProviderOrder, type ProviderId } from "./config";
import {
  fromAdapter,
  listProviders,
  registerProvider,
  resolveCorridor,
  type CorridorResolution,
  type PayoutProvider,
} from "./provider";
import type { PayoutAdapter, PayoutCurrency } from "./types";

// ─── Registration ───────────────────────────────────────────────────────────

let _registered = false;

/**
 * Register every known provider exactly once. Idempotent, and safe to call from
 * any request path (module-level side effects are avoided so a route that only
 * needs types doesn't pay for provider construction).
 */
export function registerAllProviders(): void {
  if (_registered) return;
  _registered = true;

  // Live rails.
  registerProvider(linqProvider);
  registerProvider(bridgeProvider);

  // Stub corridors. Registered so diagnostics can SHOW them as "planned, not
  // usable" rather than pretending the corridor does not exist, but `live:false`
  // keeps them unselectable outside development.
  for (const adapter of [
    paynowSgAdapter,
    zenginJpAdapter,
    mpesaKeAdapter,
    makeGenericBankAdapter("GHS"),
    makeGenericBankAdapter("ZAR"),
  ] as PayoutAdapter[]) {
    registerProvider(fromAdapter(adapter));
  }
}

// ─── Corridor queries ───────────────────────────────────────────────────────

/**
 * Resolve a corridor to the provider that should serve it right now, including
 * per-candidate reasons when it can't be served. This is the single resolution
 * point every off-ramp route should use.
 */
export async function resolvePayoutCorridor(
  ccy: PayoutCurrency
): Promise<CorridorResolution> {
  registerAllProviders();
  return resolveCorridor(ccy);
}

/** The configured provider order for a corridor (primary first). */
export function corridorProviders(ccy: PayoutCurrency): ProviderId[] {
  return corridorProviderOrder(ccy);
}

/** Whether ANY provider is configured for this corridor (health aside). */
export function corridorConfigured(ccy: PayoutCurrency): boolean {
  return corridorProviderOrder(ccy).length > 0;
}

/** All registered providers, for admin/diagnostics. */
export function allProviders(): PayoutProvider[] {
  registerAllProviders();
  return listProviders();
}

/** Currencies with at least one configured provider. */
export function supportedCurrencies(): PayoutCurrency[] {
  const all: PayoutCurrency[] = [
    "NGN",
    "KES",
    "GHS",
    "ZAR",
    "JPY",
    "SGD",
    "PHP",
    "IDR",
    "VND",
    "USD",
    "EUR",
  ];
  return all.filter((c) => corridorProviderOrder(c).length > 0);
}

// ─── Back-compat shims ──────────────────────────────────────────────────────

/**
 * DEPRECATED. Kept so nothing that imported the old flat registry breaks, but it
 * now returns the PRIMARY provider (not a mock), or `null` when the corridor has
 * none. Prefer `resolvePayoutCorridor`, which also reports health and fallbacks.
 */
export function adapterForCurrency(ccy: PayoutCurrency): PayoutProvider | null {
  registerAllProviders();
  const [primary] = corridorProviderOrder(ccy);
  if (!primary) return null;
  return listProviders().find((p) => p.id === primary) ?? null;
}

/** DEPRECATED, see {@link adapterForCurrency}. */
export function hasAdapter(ccy: PayoutCurrency): boolean {
  return corridorProviderOrder(ccy).length > 0;
}
