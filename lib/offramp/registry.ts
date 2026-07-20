/**
 * Corridor registry: destination currency → payout adapter.
 *
 * This is the single resolution point the off-ramp routes use to pick a
 * provider for a corridor, a `toCcy → PayoutAdapter` lookup (master plan
 * §4 provider-agnostic contract).
 *
 * The live NGN off-ramp is the Linq engine behind its existing
 * `web/app/api/offramp/linq/*` routes, it is intentionally NOT registered
 * here so this additive scaffolding cannot alter the live NGN path. NGN is
 * therefore listed as a "reserved, served by Linq" corridor: a caller that
 * asks the registry for NGN is told to use the Linq routes rather than
 * silently getting a stub.
 */

import type { PayoutAdapter, PayoutCurrency } from "./types";
import { paynowSgAdapter } from "./paynow-sg";
import { zenginJpAdapter } from "./zengin-jp";
import { mpesaKeAdapter } from "./mpesa-ke";
import { makeGenericBankAdapter } from "./generic-bank";

/**
 * Corridors served by the new provider-agnostic stub adapters. Each value
 * is a single adapter keyed by the destination currency it pays out.
 */
const ADAPTERS: Partial<Record<PayoutCurrency, PayoutAdapter>> = {
  SGD: paynowSgAdapter,
  JPY: zenginJpAdapter,
  KES: mpesaKeAdapter,
  GHS: makeGenericBankAdapter("GHS"),
  ZAR: makeGenericBankAdapter("ZAR"),
};

/**
 * Currencies whose off-ramp is owned by a dedicated route stack outside
 * this registry. NGN is served by the live Linq routes; resolving it here
 * returns `null` so callers fall through to Linq rather than a stub.
 */
const RESERVED: ReadonlySet<PayoutCurrency> = new Set<PayoutCurrency>(["NGN"]);

/**
 * Resolve the payout adapter for a destination currency, or `null` if no
 * adapter serves it (unsupported, or reserved for a dedicated route stack
 * such as Linq/NGN).
 */
export function adapterForCurrency(ccy: PayoutCurrency): PayoutAdapter | null {
  if (RESERVED.has(ccy)) return null;
  return ADAPTERS[ccy] ?? null;
}

/**
 * Whether the registry can serve this corridor with a registered adapter.
 */
export function hasAdapter(ccy: PayoutCurrency): boolean {
  return !RESERVED.has(ccy) && ccy in ADAPTERS;
}

/** All currencies the registry can serve directly (excludes reserved). */
export function supportedCurrencies(): PayoutCurrency[] {
  return Object.keys(ADAPTERS) as PayoutCurrency[];
}

/** All registered adapters, for admin/diagnostics. */
export function listAdapters(): PayoutAdapter[] {
  return Object.values(ADAPTERS).filter((a): a is PayoutAdapter => Boolean(a));
}
