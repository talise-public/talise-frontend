/**
 * Singapore PayNow / FAST payout adapter (STUB).
 *
 * Corridor: USDsui → SGD, credited over PayNow (alias: phone / NRIC / UEN)
 * or FAST (bank account). Master plan §4 routes this through an
 * MAS-licensed PSP/MPI (Nium, dtcpay, StraitsX/XSGD, Airwallex/Currencycloud)
 * while Talise's own MPI pends.
 *
 * This implementation makes NO live partner calls — it returns deterministic
 * mock shapes so the corridor registry and route contract can be exercised
 * end-to-end. Replace the bodies with the chosen PSP's API when the SG leg
 * goes live; the interface stays fixed.
 */

import type {
  PayoutAdapter,
  PayoutRequest,
  PayoutResult,
  PayoutStatusResult,
  Quote,
  QuoteRequest,
} from "./types";
import { buildMockQuote, mockProviderReference, mockStatus } from "./mock";

const PROVIDER = "paynow";

export const paynowSgAdapter: PayoutAdapter = {
  id: "paynow-sg",
  currency: "SGD",
  displayName: "Singapore PayNow / FAST",

  async quote(req: QuoteRequest): Promise<Quote> {
    if (req.toCcy !== "SGD") {
      throw new Error(`paynow-sg adapter only handles SGD, got ${req.toCcy}`);
    }
    return buildMockQuote(req);
  },

  async initiatePayout(req: PayoutRequest): Promise<PayoutResult> {
    // Accepts either a PayNow alias (phone/NRIC/UEN/PayNow proxy) or a
    // FAST bank account. A real PSP would name-resolve and validate here.
    return {
      providerReference: mockProviderReference(PROVIDER, req.reference),
      status: "pending",
    };
  },

  async status(providerReference: string): Promise<PayoutStatusResult> {
    return mockStatus(`paynow-sg stub: ${providerReference} pending`);
  },
};
