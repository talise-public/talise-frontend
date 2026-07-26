import "server-only";

import { BridgeError, bridgeConfigured } from "@/lib/bridge/client";

import { withBreaker, providerErrorForStatus, ProviderRequestError } from "./breaker";
import { providerBaseUrl } from "./config";
import { QUOTE_TTL_MS } from "./mock";
import type { PayoutProvider, PayoutSubmission, ProviderReadiness } from "./provider";
import type {
  PayoutCurrency,
  PayoutResult,
  PayoutStatusResult,
  Quote,
  QuoteRequest,
} from "./types";

/**
 * Bridge.xyz payout provider, the SECOND real fiat-out rail.
 *
 * Bridge is the credible second implementation because it is already live and
 * keyed for the on-ramp: USD (ACH/wire) and EUR (SEPA) payouts against a
 * persistent Sui deposit address. No new commercial relationship is invented
 * here, and no credentials are fabricated: if `BRIDGE_API_KEY` is unset this
 * provider reports itself unconfigured and the router skips it.
 *
 * WHAT BRIDGE CANNOT DO
 * ---------------------
 * Bridge does NOT pay out NGN. So it is NOT a fallback for the Nigerian
 * corridor, and pretending otherwise in the routing table would be a lie that
 * fails at the worst possible moment. Nigeria's second provider has to be a
 * commercial decision (see docs/strategy/offramp-provider-failover.md §4); what
 * this file provides is proof that the seam takes a real second implementation,
 * and a live rail for the USD/EUR corridors.
 *
 * SHAPE MISMATCH, HANDLED HONESTLY
 * --------------------------------
 * Bridge's off-ramp is address-based and per-customer: a payout needs a Bridge
 * customer id (from KYC) and a registered external bank account, which live in
 * `onramp_kyc` and Bridge respectively, not in a `PayoutDestination`. Rather
 * than fake a push-payout API, `initiatePayout` requires the caller to pass the
 * Bridge customer + external-account ids through `PayoutSubmission.remarks`-free
 * structured metadata (see `BridgeDestinationMeta`). Callers that don't have
 * those ids get a clear `ProviderRequestError` instead of a mystery 500.
 */

const SUPPORTED: readonly PayoutCurrency[] = ["USD", "EUR"] as const;

/**
 * The Bridge-specific coordinates a payout needs, carried on the destination's
 * `accountName`-adjacent metadata by the calling route. Kept explicit so the
 * dependency on Bridge KYC state is visible at the type level.
 */
export interface BridgeDestinationMeta {
  customerId: string;
  externalAccountId: string;
  destinationPaymentRail: string;
  destinationCurrency: "usd" | "eur";
}

const _meta = new WeakMap<object, BridgeDestinationMeta>();

/**
 * Attach Bridge coordinates to a submission. The route that already resolved
 * the Bridge customer (see `app/api/offramp/bridge/*`) calls this immediately
 * before `submitPayout`, so the provider never has to guess or re-derive KYC
 * state.
 */
export function attachBridgeMeta(
  submission: PayoutSubmission,
  meta: BridgeDestinationMeta
): PayoutSubmission {
  _meta.set(submission as unknown as object, meta);
  return submission;
}

export const bridgeProvider: PayoutProvider = {
  id: "bridge",
  displayName: "Bridge.xyz (USD ACH/wire, EUR SEPA)",
  currencies: SUPPORTED,
  live: true,

  configured(): ProviderReadiness {
    if (!bridgeConfigured()) {
      return { ok: false, reason: "BRIDGE_API_KEY is not set" };
    }
    const base = providerBaseUrl("bridge", "BRIDGE_API_BASE", {
      defaultUrl: "https://api.bridge.xyz/v0",
    });
    if (!base.ok) return { ok: false, reason: base.reason };
    if (!process.env.BRIDGE_WEBHOOK_PUBKEY) {
      // Not fatal for submitting a payout, but it IS fatal for knowing whether
      // the payout ever settled: without the pubkey every settlement webhook is
      // discarded as unverifiable, so the corridor would run blind.
      return {
        ok: false,
        reason:
          "BRIDGE_WEBHOOK_PUBKEY is not set, settlement webhooks cannot be verified so payouts would be unobservable",
      };
    }
    return { ok: true };
  },

  /**
   * Bridge quotes are effectively 1:1 for USD (USDC → USD at par, minus the
   * developer fee), so there is no FX leg to lock for the USD corridor. We
   * return a par quote rather than inventing a rate.
   */
  async quote(req: QuoteRequest): Promise<Quote> {
    if (!SUPPORTED.includes(req.toCcy)) {
      throw new ProviderRequestError(
        `bridge provider does not pay out ${req.toCcy}`,
        "bridge",
        400
      );
    }
    return {
      quoteId: `bridge-par-${Date.now()}`,
      usdsuiAmount: req.toAmount,
      toAmount: req.toAmount,
      toCcy: req.toCcy,
      fxRate: 1,
      spreadBps: 0,
      accountName: req.destination?.accountName,
      expiresAt: Date.now() + QUOTE_TTL_MS,
    };
  },

  async initiatePayout(req: PayoutSubmission): Promise<PayoutResult> {
    if (!SUPPORTED.includes(req.toCcy)) {
      throw new ProviderRequestError(
        `bridge provider does not pay out ${req.toCcy}`,
        "bridge",
        400
      );
    }
    const meta = _meta.get(req as unknown as object);
    if (!meta) {
      throw new ProviderRequestError(
        "bridge payouts need a Bridge customer + external account; call attachBridgeMeta() first",
        "bridge",
        409
      );
    }
    const { createOfframpTransfer } = await import("@/lib/bridge/offramp");
    const transfer = await withBreaker("bridge", async () => {
      try {
        return await createOfframpTransfer({
          customerId: meta.customerId,
          amount: req.toAmount.toFixed(2),
          // Bridge needs the sending Sui address; the caller encodes it as the
          // destination alias so this stays a pure function of the submission.
          fromAddress:
            req.destination.kind === "alias" ? req.destination.alias : "",
          externalAccountId: meta.externalAccountId,
          destinationPaymentRail: meta.destinationPaymentRail,
          destinationCurrency: meta.destinationCurrency,
          // Bridge honours Idempotency-Key for 24h, so a retry with the router's
          // key returns the original transfer instead of creating a second one.
          idempotencyKey: req.idempotencyKey,
        });
      } catch (e) {
        // Translate Bridge's typed error into the breaker's taxonomy so a 400
        // (bad routing number) does not trip the circuit while a 502 does.
        if (e instanceof BridgeError) {
          throw providerErrorForStatus("bridge", e.status, `${e.code}: ${e.message}`);
        }
        throw e;
      }
    });
    return {
      providerReference: transfer.id,
      status: bridgeStateToStatus(transfer.state),
    };
  },

  async status(providerReference: string): Promise<PayoutStatusResult> {
    const { bridgeFetch } = await import("@/lib/bridge/client");
    const transfer = await withBreaker("bridge", async () => {
      try {
        return await bridgeFetch<{ id: string; state?: string }>(
          `transfers/${encodeURIComponent(providerReference)}`
        );
      } catch (e) {
        if (e instanceof BridgeError) {
          throw providerErrorForStatus("bridge", e.status, `${e.code}: ${e.message}`);
        }
        throw e;
      }
    });
    return {
      status: bridgeStateToStatus(transfer.state),
      message: transfer.state ?? "",
    };
  },
};

/**
 * Map Bridge's transfer `state` onto the corridor-agnostic payout status.
 *
 * Only `payment_processed` means the recipient's bank was actually paid.
 * `funds_received` means Bridge has the crypto but has NOT paid fiat yet, so
 * treating it as settled would tell the user their money arrived when it has
 * only left them, exactly the class of lie this rework exists to remove.
 */
export function bridgeStateToStatus(
  state: string | undefined
): PayoutResult["status"] {
  const s = (state ?? "").toLowerCase();
  if (s === "payment_processed" || s === "completed") return "settled";
  if (
    s === "canceled" ||
    s === "cancelled" ||
    s === "returned" ||
    s === "error" ||
    s === "refunded" ||
    s === "undeliverable"
  ) {
    return "failed";
  }
  return "pending";
}
