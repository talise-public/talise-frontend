/**
 * Shared helpers for the stub payout adapters.
 *
 * These exist purely so each mock adapter (paynow-sg, zengin-jp, mpesa-ke,
 * generic-bank) prices and shapes its responses consistently with the live
 * Linq reference, WITHOUT making any partner call. When a corridor goes
 * live its adapter swaps the mock body for real PSP requests + the shared
 * live FX feed; the interface and the route contract stay identical.
 */

import { randomUUID } from "node:crypto";

import type {
  PayoutCurrency,
  Quote,
  QuoteRequest,
  PayoutStatusResult,
} from "./types";

/** Quote TTL, mirroring the Linq quote-lock. */
export const QUOTE_TTL_MS = 60_000;

/** Tight launch spread, matching the Linq route default (25bps). */
export const DEFAULT_SPREAD_BPS = 25;

/**
 * Hardcoded fiat-per-USD snapshot for the corridors not yet in
 * `web/lib/fx.ts`. This is a stand-in for the live FX feed the master plan
 * (§2 P0, FX-off-snapshot) calls for, the FX workstream will replace it.
 * Values are an approximate Q2 2026 snapshot and are NOT exported as the
 * app's display rates.
 */
const MOCK_FX: Record<PayoutCurrency, number> = {
  NGN: 1620,
  KES: 132,
  GHS: 14,
  ZAR: 18.5,
  JPY: 157,
  SGD: 1.34,
  PHP: 58,
  IDR: 16_300,
  VND: 25_400,
  USD: 1,
};

/** USDSUI on-chain decimals, mirrors `web/lib/sui.ts`' USDSUI_DECIMALS. */
const USDSUI_DECIMALS = 6;

/**
 * Read the configured spread, falling back to {@link DEFAULT_SPREAD_BPS}.
 * Same env var the Linq route uses so spread stays single-sourced.
 */
export function spreadBps(): number {
  const v = Number(process.env.OFFRAMP_SPREAD_BPS ?? DEFAULT_SPREAD_BPS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_SPREAD_BPS;
}

/**
 * Price a `toAmount` of destination fiat into a TTL-locked {@link Quote},
 * applying the Talise spread to the mock mid-market rate exactly the way
 * the Linq `/quote` route does: the user is debited
 * `toAmount / (mid * (1 - spread))` USDsui, ceil-rounded to 6dp.
 */
export function buildMockQuote(req: QuoteRequest): Quote {
  const mid = MOCK_FX[req.toCcy];
  const bps = spreadBps();
  const fxEffective = mid * (1 - bps / 10_000);
  const usdsuiAmount =
    Math.ceil((req.toAmount / fxEffective) * 10 ** USDSUI_DECIMALS) /
    10 ** USDSUI_DECIMALS;
  const now = Date.now();
  return {
    quoteId: randomUUID(),
    usdsuiAmount,
    toAmount: req.toAmount,
    toCcy: req.toCcy,
    fxRate: fxEffective,
    spreadBps: bps,
    accountName: req.destination?.accountName,
    expiresAt: now + QUOTE_TTL_MS,
  };
}

/**
 * Deterministic mock provider reference so a given Talise `reference`
 * always maps to the same provider id (idempotency parity with Linq
 * `referenceNumber` reuse), without persistence.
 */
export function mockProviderReference(prefix: string, reference: string): string {
  return `${prefix}_${reference}`;
}

/**
 * Mock status poll. With no real partner state to read, a stub reports
 * `pending` so the orchestrating route's poll loop behaves identically to
 * the Linq path until the real adapter lands. Overridable per adapter if a
 * corridor wants a different default.
 */
export function mockStatus(message: string): PayoutStatusResult {
  return { status: "pending", message };
}
