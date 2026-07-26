import "server-only";

import {
  createOrder,
  getOrderStatus,
  getRate,
  linqConfigured,
  linqReadiness,
} from "@/lib/linq";
import { resolveLinqBank } from "@/lib/linq-banks";

import { spreadBps, QUOTE_TTL_MS } from "./mock";
import { phaseOf } from "./status";
import type { PayoutProvider, PayoutSubmission, ProviderReadiness } from "./provider";
import type {
  PayoutCurrency,
  PayoutResult,
  PayoutStatusResult,
  Quote,
  QuoteRequest,
} from "./types";

/**
 * Linq NGN payout provider, the live Nigerian rail behind the
 * `PayoutProvider` seam.
 *
 * WHAT IS DIFFERENT ABOUT THIS RAIL
 * ---------------------------------
 * Linq is DEPOSIT-ADDRESS based, not push-based. We create an order; Linq hands
 * back a wallet it watches; the USER sends USDsui there; Linq pays the bank.
 * There is therefore no moment where Talise holds a debit it must pay out, but
 * there IS a moment where the user has irrevocably sent funds to a third party
 * we do not control. Everything protective has to happen BEFORE that send:
 * a healthy-provider check, an idempotency claim, and a persisted record with a
 * refund address.
 *
 * `initiatePayout` here creates the ORDER (returning the provider reference); the
 * deposit itself is the client's on-chain send, which is why the existing
 * `app/api/offramp/linq/*` routes still own that choreography. Registering Linq
 * as a provider gives the router health, ordering, and failover semantics
 * without rewriting the live path.
 */

const NGN: PayoutCurrency = "NGN";

export const linqProvider: PayoutProvider = {
  id: "linq",
  displayName: "Linq (Nigeria bank payout)",
  currencies: [NGN],
  live: true,

  configured(): ProviderReadiness {
    return linqReadiness();
  },

  async quote(req: QuoteRequest): Promise<Quote> {
    if (req.toCcy !== NGN) {
      throw new Error(`linq provider only serves NGN, got ${req.toCcy}`);
    }
    // No explicit breaker call: every Linq HTTP call is already gated + observed
    // inside `linqFetch` (lib/linq.ts), so wrapping again would double-count.
    const rate = await getRate();
    const mid = rate.rate;
    if (!Number.isFinite(mid) || mid <= 0) {
      throw new Error("linq returned an unusable rate");
    }
    const bps = spreadBps();
    const fxEffective = mid * (1 - bps / 10_000);
    const usdsuiAmount = Math.ceil((req.toAmount / fxEffective) * 1e6) / 1e6;
    return {
      // Linq has no separate quote object: the ORDER locks the rate. The id is
      // therefore advisory and must not be treated as a lock by callers.
      quoteId: `linq-display-${Date.now()}`,
      usdsuiAmount,
      toAmount: req.toAmount,
      toCcy: NGN,
      fxRate: fxEffective,
      spreadBps: bps,
      accountName: req.destination?.accountName,
      expiresAt: Date.now() + QUOTE_TTL_MS,
    };
  },

  async initiatePayout(req: PayoutSubmission): Promise<PayoutResult> {
    if (req.toCcy !== NGN) {
      throw new Error(`linq provider only serves NGN, got ${req.toCcy}`);
    }
    if (req.destination.kind !== "bank") {
      throw new Error("linq requires a bank destination (10-digit NUBAN + bank code)");
    }
    const bank = resolveLinqBank(req.destination.bankCode);
    if (!bank) {
      throw new Error(`unsupported Nigerian bankCode "${req.destination.bankCode}"`);
    }
    const order = await createOrder({
      amountStableCoin: req.usdAmount,
      bankAccount: req.destination.accountNumber,
      bankCode: req.destination.bankCode,
      bankName: bank.name,
      accountName: req.destination.accountName ?? "",
      customerRef: req.reference,
      // The router's idempotency key IS the provider key: Linq returns the
      // original order for a repeated key, so a retry can never double-pay even
      // if our own claim table were lost.
      idempotencyKey: req.idempotencyKey,
    });
    return {
      providerReference: order.id,
      status: phaseOf(order.status) === "completed" ? "settled" : "pending",
    };
  },

  async status(providerReference: string): Promise<PayoutStatusResult> {
    const live = await getOrderStatus(providerReference);
    const phase = phaseOf(live.status);
    return {
      status: phase === "completed" ? "settled" : phase === "failed" ? "failed" : "pending",
      message: live.status ?? "",
    };
  },
};

/** Exported for diagnostics: is the Linq rail even wired up? */
export function linqAvailable(): boolean {
  return linqConfigured();
}
