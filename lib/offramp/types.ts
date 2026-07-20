/**
 * Provider-agnostic off-ramp payout interface.
 *
 * Talise is a settlement-and-FX orchestrator, not a ramp reseller
 * (master plan §4): it owns the on-chain leg and bolts local fiat legs
 * on via swappable BaaS/PSP partners behind ONE internal interface. The
 * live Linq NGN integration (`web/lib/linq.ts` + `web/app/api/offramp/linq/*`)
 * is the canonical reference, every adapter here mirrors its three-step
 * shape:
 *
 *   quote          → TTL-locked USDsui → local-currency price (Linq `quote`)
 *   initiatePayout → fire the fiat-out leg, get a provider reference
 *                    (Linq order create)
 *   status         → poll the provider for settlement
 *                    (Linq status poll)
 *
 * Each adapter maps these onto a single corridor's destination currency.
 * The registry (`registry.ts`) resolves `toCcy → adapter`. The Linq route
 * handlers are left untouched; this module is additive scaffolding for the
 * Asian/global corridors (master plan §4 per-corridor table).
 *
 * NOTE: the stub adapters return mock data only. No live partner calls are
 * made, wiring real PSP/bank requests, persistence, and on-chain
 * verification is out of scope for this slice and lands per-corridor later.
 */

/**
 * The destination fiat currencies Talise off-ramps into. A superset of
 * `web/lib/fx.ts`' display `Currency` so the corridor map can name JPY/SGD/
 * PHP/IDR/VND payouts that the display layer does not yet render.
 */
export type PayoutCurrency =
  | "NGN" // Nigeria    , Linq (live)
  | "KES" // Kenya      , M-Pesa
  | "GHS" // Ghana      , generic bank
  | "ZAR" // South Africa, generic bank
  | "JPY" // Japan      , Zengin furikomi
  | "SGD" // Singapore  , PayNow / FAST
  | "PHP" // Philippines, (SG→ASEAN payout network)
  | "IDR" // Indonesia  , (SG→ASEAN payout network)
  | "VND" // Vietnam    , (SG→ASEAN payout network)
  | "USD"; // United States, RTP/FedNow/ACH

/**
 * The corridor-agnostic payout lifecycle. Generalizes the Linq
 * `quoted → debited → remitting → settled | failed` row state into the
 * provider-leg states the master plan §3 transfers machine describes
 * (`… → fiat_out_pending → settled`). An adapter only ever reports the
 * fiat-out leg states, `quoted`/`debited`/on-chain settling belong to the
 * orchestrating route + ledger, not the payout provider.
 */
export type PayoutStatus =
  | "pending" // accepted by the provider, fiat not yet credited
  | "settled" // local-currency funds credited to the recipient
  | "failed"; // provider rejected or the wire bounced

/**
 * A discriminated destination. Bank corridors (Zengin, generic GH/ZA, US
 * ACH) need a bank/account pair; instant-rail corridors (PayNow, M-Pesa)
 * settle to an alias (phone, NRIC/UEN, PayNow proxy). Adapters validate
 * the shape they accept and reject the rest.
 */
export type PayoutDestination =
  | {
      kind: "bank";
      /** Provider/clearing bank identifier (SWIFT/BIC, Zengin code, sort-equivalent). */
      bankCode: string;
      accountNumber: string;
      /** Optional branch code (e.g. Japan Zengin 3-digit branch / shiten). */
      branchCode?: string;
      /** Account holder name, when known (some rails require an exact match). */
      accountName?: string;
    }
  | {
      kind: "alias";
      /** What the alias represents on this rail. */
      aliasType: "phone" | "nric" | "uen" | "vpa" | "paynow";
      /** The alias value itself (e.g. +6591234567, S1234567A). */
      alias: string;
      accountName?: string;
    };

/** Input to {@link PayoutAdapter.quote}. */
export interface QuoteRequest {
  /**
   * Amount of destination fiat the recipient should receive, in MAJOR
   * units (e.g. 50000 = ¥50,000, 100 = S$100.00). Mirrors Linq
   * `ngnAmount`. Adapters that settle in minor-unit-only currencies round
   * per their own convention.
   */
  toAmount: number;
  /** Destination currency. Must equal the corridor the adapter serves. */
  toCcy: PayoutCurrency;
  /** Where the money lands. Optional at quote time for a price-only preview. */
  destination?: PayoutDestination;
}

/** A TTL-locked quote. Mirrors the Linq `/quote` response. */
export interface Quote {
  /** Opaque provider/corridor quote id, echoed back on initiatePayout. */
  quoteId: string;
  /** USDsui (1:1 USD) the user is debited, 6dp. */
  usdsuiAmount: number;
  /** Destination fiat the recipient receives, major units. */
  toAmount: number;
  toCcy: PayoutCurrency;
  /** Effective fiat-per-USD rate after the Talise spread. */
  fxRate: number;
  /** Spread applied, in basis points. */
  spreadBps: number;
  /** Resolved recipient name when the rail supports name-enquiry. */
  accountName?: string;
  /** Epoch ms after which the quote must be re-fetched. */
  expiresAt: number;
}

/** Input to {@link PayoutAdapter.initiatePayout}. */
export interface PayoutRequest {
  /** The locked quote being executed. */
  quoteId: string;
  /** Where the money lands. */
  destination: PayoutDestination;
  /**
   * Caller-owned idempotency key (Talise's transfer/row id). Re-initiating
   * with the same reference MUST NOT double-pay, mirrors how Linq reuses
   * `referenceNumber`.
   */
  reference: string;
  /** Free-text remarks / payment narrative, where the rail carries one. */
  remarks?: string;
}

/** Result of {@link PayoutAdapter.initiatePayout}. */
export interface PayoutResult {
  /** The provider's own reference for the fiat-out leg. */
  providerReference: string;
  status: PayoutStatus;
}

/** Result of {@link PayoutAdapter.status}. */
export interface PayoutStatusResult {
  status: PayoutStatus;
  /** Human-readable provider message, when present. */
  message: string;
}

/**
 * The one interface every corridor implements. Implementations are pure
 * wrappers over a partner API (or, for now, a deterministic mock), they
 * own NO persistence and NO on-chain logic; the route handlers + ledger do.
 */
export interface PayoutAdapter {
  /** Stable adapter id, e.g. "paynow-sg". */
  readonly id: string;
  /** The single corridor currency this adapter pays out. */
  readonly currency: PayoutCurrency;
  /** Human label for logs/admin, e.g. "Singapore PayNow / FAST". */
  readonly displayName: string;

  /** Build a TTL-locked USDsui → fiat quote. */
  quote(req: QuoteRequest): Promise<Quote>;

  /** Fire the fiat-out leg. Idempotent on `reference`. */
  initiatePayout(req: PayoutRequest): Promise<PayoutResult>;

  /** Poll the provider for the settlement state of a prior payout. */
  status(providerReference: string): Promise<PayoutStatusResult>;
}
