/**
 * Japan Zengin furikomi payout adapter (STUB).
 *
 * Corridor: USDsui → JPY, credited by furikomi (振込) into a named bank
 * account over the Zengin system. Master plan §4 routes JPY⇄stablecoin via
 * JPYC Inc. (FSA Type-II, ¥1M per-transfer cap) with GMO Aozora Net Bank /
 * Komoju/DG for the bank+conbini rails; >¥1M needs a Type 1 FTSP + EPIBP
 * partner.
 *
 * This implementation makes NO live partner calls. JPY is a zero-decimal
 * currency, so `toAmount` is treated as whole yen. The ¥1M JPYC cap is
 * enforced as a stub guard to model the real legal constraint; swap the
 * body for the live rail (and the right cap per partner) when JP launches.
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

const PROVIDER = "zengin";

/** JPYC FSA Type-II per-transfer cap (master plan §4 / §5 Japan). */
const JPYC_TRANSFER_CAP_YEN = 1_000_000;

export const zenginJpAdapter: PayoutAdapter = {
  id: "zengin-jp",
  currency: "JPY",
  displayName: "Japan bank transfer (Zengin furikomi)",

  async quote(req: QuoteRequest): Promise<Quote> {
    if (req.toCcy !== "JPY") {
      throw new Error(`zengin-jp adapter only handles JPY, got ${req.toCcy}`);
    }
    if (req.toAmount > JPYC_TRANSFER_CAP_YEN) {
      throw new Error(
        `zengin-jp: ¥${req.toAmount} exceeds the ¥${JPYC_TRANSFER_CAP_YEN} JPYC per-transfer cap`
      );
    }
    return buildMockQuote(req);
  },

  async initiatePayout(req: PayoutRequest): Promise<PayoutResult> {
    if (req.destination.kind !== "bank") {
      throw new Error("zengin-jp requires a bank destination (account + branch)");
    }
    // A real rail would resolve the recipient name and submit the furikomi
    // with bank code + 3-digit branch (shiten) + account number.
    return {
      providerReference: mockProviderReference(PROVIDER, req.reference),
      status: "pending",
    };
  },

  async status(providerReference: string): Promise<PayoutStatusResult> {
    return mockStatus(`zengin-jp stub: ${providerReference} pending`);
  },
};
