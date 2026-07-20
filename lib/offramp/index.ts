/**
 * Provider-agnostic off-ramp payout layer (master plan §4).
 *
 * Public surface:
 *   - types     , the `PayoutAdapter` interface + request/response shapes
 *   - registry  , `adapterForCurrency(toCcy)` corridor resolution
 *   - adapters  , paynow-sg, zengin-jp, mpesa-ke, generic-bank (stubs)
 *
 * The live NGN off-ramp is the Linq engine behind
 * `web/app/api/offramp/linq/*` and is deliberately not routed through this
 * registry. Everything here is additive scaffolding; nothing imports it
 * into the live NGN path yet.
 */

export * from "./types";
export * from "./registry";
export { paynowSgAdapter } from "./paynow-sg";
export { zenginJpAdapter } from "./zengin-jp";
export { mpesaKeAdapter } from "./mpesa-ke";
export { makeGenericBankAdapter } from "./generic-bank";
export type { GenericBankCurrency } from "./generic-bank";
