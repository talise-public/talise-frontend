/**
 * Kenya M-Pesa payout adapter (STUB).
 *
 * Corridor: USDsui → KES, credited to an M-Pesa wallet (Safaricom Daraja
 * B2C) addressed by phone number. M-Pesa is the dominant Kenyan retail
 * rail, so the destination is an `alias` (phone), not a bank account.
 *
 * This implementation makes NO live partner calls. Replace the body with a
 * Daraja B2C request (or an aggregator) when the KE leg goes live; the
 * interface stays fixed.
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

const PROVIDER = "mpesa";

export const mpesaKeAdapter: PayoutAdapter = {
  id: "mpesa-ke",
  currency: "KES",
  displayName: "Kenya M-Pesa",

  async quote(req: QuoteRequest): Promise<Quote> {
    if (req.toCcy !== "KES") {
      throw new Error(`mpesa-ke adapter only handles KES, got ${req.toCcy}`);
    }
    return buildMockQuote(req);
  },

  async initiatePayout(req: PayoutRequest): Promise<PayoutResult> {
    if (req.destination.kind !== "alias" || req.destination.aliasType !== "phone") {
      throw new Error("mpesa-ke requires an alias destination of type 'phone'");
    }
    // A real rail would fire a Daraja B2C PaymentRequest keyed by
    // `reference` (idempotent) to the recipient MSISDN.
    return {
      providerReference: mockProviderReference(PROVIDER, req.reference),
      status: "pending",
    };
  },

  async status(providerReference: string): Promise<PayoutStatusResult> {
    return mockStatus(`mpesa-ke stub: ${providerReference} pending`);
  },
};
