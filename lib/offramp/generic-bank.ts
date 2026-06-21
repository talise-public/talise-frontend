/**
 * Generic bank payout adapter (STUB).
 *
 * Corridor: USDsui → a local-currency bank account over whatever instant /
 * batch clearing rail the destination market exposes. Used for the
 * corridors that have no bespoke adapter yet — Ghana (GHS) and South
 * Africa (ZAR) per the master plan §4 expansion table — behind a generic
 * BaaS/PSP partner.
 *
 * Unlike the single-currency adapters, this one is parameterized by
 * currency at construction, so the registry can register one instance per
 * generic-bank corridor while reusing the same logic. It makes NO live
 * partner calls.
 */

import type {
  PayoutAdapter,
  PayoutCurrency,
  PayoutRequest,
  PayoutResult,
  PayoutStatusResult,
  Quote,
  QuoteRequest,
} from "./types";
import { buildMockQuote, mockProviderReference, mockStatus } from "./mock";

const PROVIDER = "bank";

/** Currencies the generic bank adapter is wired for in this slice. */
export type GenericBankCurrency = "GHS" | "ZAR";

const DISPLAY_NAME: Record<GenericBankCurrency, string> = {
  GHS: "Ghana bank transfer",
  ZAR: "South Africa bank transfer (EFT)",
};

/**
 * Build a generic-bank adapter bound to a single destination currency.
 * The registry calls this once per generic corridor.
 */
export function makeGenericBankAdapter(currency: GenericBankCurrency): PayoutAdapter {
  return {
    id: `generic-bank-${currency.toLowerCase()}`,
    currency: currency as PayoutCurrency,
    displayName: DISPLAY_NAME[currency],

    async quote(req: QuoteRequest): Promise<Quote> {
      if (req.toCcy !== currency) {
        throw new Error(
          `generic-bank(${currency}) adapter cannot quote ${req.toCcy}`
        );
      }
      return buildMockQuote(req);
    },

    async initiatePayout(req: PayoutRequest): Promise<PayoutResult> {
      if (req.destination.kind !== "bank") {
        throw new Error(`generic-bank(${currency}) requires a bank destination`);
      }
      return {
        providerReference: mockProviderReference(`${PROVIDER}-${currency.toLowerCase()}`, req.reference),
        status: "pending",
      };
    },

    async status(providerReference: string): Promise<PayoutStatusResult> {
      return mockStatus(`generic-bank(${currency}) stub: ${providerReference} pending`);
    },
  };
}
