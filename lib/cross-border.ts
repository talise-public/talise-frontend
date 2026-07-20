import "server-only";

import { db, ensureSchema, userById } from "@/lib/db";
import {
  corridorQuote,
  getCorridor,
  isCorridorBookable,
  corridorAccessForTier,
  type CountryCode,
  type Corridor,
} from "@/lib/corridors";
import { getRateTable } from "@/lib/fx-feed";
import { isCurrency, type Currency } from "@/lib/fx";
import { getUserTier, TIER_LIMITS, type KycTier } from "@/lib/kyc";
import { isAdminIdentity } from "@/lib/admin";
import {
  createTransfer,
  getTransfer,
  advanceTransfer,
  type TransferRecord,
  type TransferState,
} from "@/lib/transfers";

/**
 * Cross-border send orchestration, the brain that composes the on-main
 * primitives (corridor registry, FX feed, KYC tiers, transfers state
 * machine) into a single, real money-movement flow.
 *
 * This module is the server-side core behind the two cross-border routes:
 *
 *   POST /api/transfers/cross-border/quote   → quoteCrossBorder(...)
 *   POST /api/transfers/cross-border/confirm → confirmCrossBorder(...)
 *
 * It is deliberately self-contained on `main`: the tier per-tx / monthly
 * cap check is inlined from `kyc.TIER_LIMITS` here rather than depending on
 * the un-merged send-limits / sanctions work. The cap math intentionally
 * mirrors the limit semantics those PRs will own; once they land, this
 * inline check can defer to the shared engine without changing the route
 * contract.
 *
 * --- Quote pipeline (quoteCrossBorder) ---
 *   1. Resolve the directed corridor (UNKNOWN_CORRIDOR / NOT_BOOKABLE).
 *   2. Convert the SOURCE-currency `amount` → USD via the live FX rate
 *      table (sourceCcy → USD). USDsui settles 1:1 with USD, so this USD
 *      figure is both the cap-check basis AND the on-chain leg amount.
 *   3. Gate KYC: tier corridor access (TIER_BLOCKED) + an inline per-tx
 *      and rolling-monthly cap check (LIMIT_EXCEEDED).
 *   4. Price the conversion via `corridorQuote` (maps the registry's
 *      UNKNOWN_CORRIDOR / NOT_BOOKABLE / OVER_CAP / FX codes through).
 *   5. Persist a `transfers` row in `quoted` with the locked quote.
 *
 * --- Confirm pipeline (confirmCrossBorder) ---
 *   Loads the transfer (ownership-checked), then drives the state machine:
 *     quoted → (debit) → debited → (start_onchain) → onchain_settling.
 *   For the LIVE NG corridor the destination fiat-out is the Linq off-ramp
 *   path; for partner corridors it advances to `fiat_out_pending` as a
 *   documented stub. The on-chain confirmation + fiat-out completion are
 *   driven later by the broadcast-confirm / PSP-webhook hooks (the commit
 *   semantics in transfers.ts are honored throughout).
 */

// ─── Error codes (route contract) ──────────────────────────────────────

/**
 * Stable error codes surfaced to the client. The corridor-registry codes
 * (UNKNOWN_CORRIDOR / NOT_BOOKABLE / OVER_CAP / FX) pass straight through
 * from `corridorQuote`; the KYC gate adds TIER_BLOCKED / LIMIT_EXCEEDED;
 * BAD_INPUT covers malformed requests caught before pricing.
 */
export type CrossBorderErrorCode =
  | "UNKNOWN_CORRIDOR"
  | "NOT_BOOKABLE"
  | "OVER_CAP"
  | "TIER_BLOCKED"
  | "LIMIT_EXCEEDED"
  | "FX"
  | "BAD_INPUT";

/** Public shape of a corridor on the quote response. */
export interface QuoteCorridor {
  id: string;
  fromCcy: string;
  toCcy: string;
  status: Corridor["status"];
  spreadBps: number;
  perTxCapUsd?: number;
}

/** Public shape of the locked FX quote on the response. */
export interface QuoteSummary {
  rate: number;
  spreadBps: number;
  toAmount: number;
  expiresAt: number;
}

export interface CrossBorderQuote {
  transferId: string;
  corridor: QuoteCorridor;
  quote: QuoteSummary;
  amountUsd: number;
  tier: KycTier;
  recipientGets: { amount: number; currency: string };
}

export type QuoteCrossBorderResult =
  | { ok: true; result: CrossBorderQuote }
  | { ok: false; code: CrossBorderErrorCode; message: string };

export type ConfirmCrossBorderResult =
  | { ok: true; state: TransferState; transferId: string }
  | {
      ok: false;
      /** "BAD_INPUT" | "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "INTERNAL". */
      code: "BAD_INPUT" | "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "INTERNAL";
      message: string;
    };

// ─── Tunables ───────────────────────────────────────────────────────────

/** Rolling window for the monthly-cap check (mirrors kyc.monthlyUsd semantics). */
const MONTHLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * States that count AGAINST a user's rolling monthly outbound cap. A
 * transfer that was aborted/failed pre-commit or refunded never moved
 * value, so it must not consume the user's headroom. Everything from
 * `debited` onward (the user committed to sending) counts. `quoted` is
 * excluded so abandoned, unconfirmed quotes can't lock a user out.
 */
const COUNTED_STATES: ReadonlySet<TransferState> = new Set<TransferState>([
  "debited",
  "onchain_settling",
  "onchain_settled",
  "fiat_out_pending",
  "settled",
]);

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Convert a SOURCE-currency amount to USD using the live FX rate table.
 * The table is `units-per-USD`, so `usd = amount / ratesPerUsd[ccy]`. USD
 * itself is 1:1. Returns null if the currency isn't in the live table (the
 * caller maps that to an FX error, we never price money off a missing
 * rate). We read the table directly (rather than `getQuote(ccy, USD, …)`)
 * because this is a pure unit conversion for the cap check; the actual
 * priced quote (with corridor spread) comes from `corridorQuote` below.
 */
async function sourceAmountToUsd(
  sourceCcy: string,
  amount: number
): Promise<number | null> {
  if (!isCurrency(sourceCcy)) return null;
  if (sourceCcy === "USD") return amount;
  const table = await getRateTable();
  const perUsd = table.ratesPerUsd[sourceCcy as Currency];
  if (typeof perUsd !== "number" || !Number.isFinite(perUsd) || perUsd <= 0) {
    return null;
  }
  return amount / perUsd;
}

/**
 * Sum the USD value of a user's cross-border transfers in the trailing
 * `MONTHLY_WINDOW_MS`, counting only states that actually consumed value
 * (`COUNTED_STATES`). Used by the inline monthly-cap check. `usdsui_amount`
 * is the on-chain USD leg (1:1 USD), which is the right cap basis.
 */
async function monthlyCrossBorderUsd(userId: number): Promise<number> {
  await ensureSchema();
  const since = Date.now() - MONTHLY_WINDOW_MS;
  const placeholders = [...COUNTED_STATES]
    .map(() => "?")
    .join(", ");
  const r = await db().execute({
    sql: `SELECT COALESCE(SUM(usdsui_amount), 0) AS total
            FROM transfers
           WHERE user_id = ?
             AND kind = 'cross_border'
             AND created_at >= ?
             AND state IN (${placeholders})`,
    args: [String(userId), since, ...COUNTED_STATES],
  });
  const raw = r.rows[0]?.total;
  const total = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(total) ? total : 0;
}

/**
 * Inline per-tx + rolling-monthly cap check against `kyc.TIER_LIMITS`.
 * Returns null when allowed, or a `LIMIT_EXCEEDED` reason string when the
 * send would breach a cap.
 *
 * Semantics mirror the (un-merged) send-limits engine so this can later
 * defer to it without a contract change:
 *   - `perTxUsd === null`  → no per-tx cap (tier 3, EDD).
 *   - `monthlyUsd === null`→ no monthly cap.
 *   - a tier with `canSend === false` (tier 0) is handled by the corridor
 *     access gate (TIER_BLOCKED) before we ever get here, but we still
 *     treat a 0 cap as a hard block defensively.
 */
function checkTierCaps(
  tier: KycTier,
  amountUsd: number,
  monthlyUsedUsd: number
): string | null {
  const limits = TIER_LIMITS[tier];

  const perTx = limits.perTxUsd;
  if (perTx !== null && amountUsd > perTx) {
    return `This transfer exceeds your per-transaction limit of $${perTx.toLocaleString()}.`;
  }

  const monthly = limits.monthlyUsd;
  if (monthly !== null && monthlyUsedUsd + amountUsd > monthly) {
    return `This transfer would exceed your monthly limit of $${monthly.toLocaleString()}. You've sent $${Math.round(
      monthlyUsedUsd
    ).toLocaleString()} in the last 30 days.`;
  }

  return null;
}

/** The PSP/rail provider key for a corridor's fiat-out leg. */
function payoutProvider(corridor: Corridor): string {
  // The live NG corridor pays out via Linq; everything else is a documented
  // partner stub until its rail is wired.
  return corridor.toCountry === "NG" ? "linq" : "partner";
}

// ─── Quote ──────────────────────────────────────────────────────────────

/**
 * Quote a cross-border send. `amount` is denominated in the corridor's
 * SOURCE currency. On success, persists a `transfers` row in `quoted` and
 * returns the locked quote + recipient payout. See module docstring for the
 * full pipeline.
 */
export async function quoteCrossBorder(
  userId: number,
  fromCountry: CountryCode,
  toCountry: CountryCode,
  amount: number
): Promise<QuoteCrossBorderResult> {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, code: "BAD_INPUT", message: "Amount must be a positive number." };
  }

  // (1) Resolve the corridor up-front so we can convert the source amount
  // to USD using the corridor's source currency. `corridorQuote` re-checks
  // existence/bookability and is the authority on pricing, but we need the
  // corridor here for the USD conversion + KYC gate that precede pricing.
  const corridor = getCorridor(fromCountry, toCountry);
  if (!corridor) {
    return { ok: false, code: "UNKNOWN_CORRIDOR", message: "No corridor for that route." };
  }
  if (!isCorridorBookable(corridor)) {
    return { ok: false, code: "NOT_BOOKABLE", message: "This corridor isn't open yet." };
  }

  // (2) Source amount → USD. USDsui is 1:1 USD, so this is the cap basis
  // and the on-chain leg amount.
  const amountUsd = await sourceAmountToUsd(corridor.fromCcy, amount);
  if (amountUsd === null) {
    return {
      ok: false,
      code: "FX",
      message: "Live FX rate unavailable for this corridor; quoting is paused.",
    };
  }

  // (3) KYC gate, corridor access first (TIER_BLOCKED), then the inline
  // per-tx / monthly cap (LIMIT_EXCEEDED).
  //
  // Admin bypass: allowlisted accounts (web/lib/admin.ts) are treated as
  // the top tier so they can test cross-border before identity
  // verification ships. Everyone else uses their real kyc_tier.
  const realTier = await getUserTier(userId);
  const adminUser = await userById(userId).catch(() => null);
  const isAdmin = isAdminIdentity(adminUser?.email, adminUser?.talise_username);
  const tier: KycTier = isAdmin ? 3 : realTier;
  if (!corridorAccessForTier(corridor, tier)) {
    return {
      ok: false,
      code: "TIER_BLOCKED",
      message:
        "Your verification tier doesn't allow this corridor. Complete identity verification to unlock cross-border sends.",
    };
  }
  const monthlyUsed = await monthlyCrossBorderUsd(userId);
  const capReason = checkTierCaps(tier, amountUsd, monthlyUsed);
  if (capReason) {
    return { ok: false, code: "LIMIT_EXCEEDED", message: capReason };
  }

  // (4) Price the conversion. `corridorQuote` enforces the per-tx USD cap
  // (OVER_CAP) and the FX breaker, and re-validates existence/bookability.
  const priced = await corridorQuote(fromCountry, toCountry, amount, amountUsd);
  if (!priced.ok) {
    // Pass the registry code straight through to the route contract.
    return { ok: false, code: priced.code, message: priced.message };
  }

  const { corridor: pricedCorridor, quote } = priced;

  // (5) Persist the locked quote as a `transfers` row in `quoted`.
  const provider = payoutProvider(pricedCorridor);
  const transfer = await createTransfer({
    userId,
    kind: "cross_border",
    provider,
    sourceCurrency: pricedCorridor.fromCcy,
    destCurrency: pricedCorridor.toCcy,
    usdsuiAmount: amountUsd,
    sourceAmount: amount,
    destAmount: quote.toAmount,
    fxRate: quote.rate,
    metadata: {
      fromCountry,
      toCountry,
      corridorId: pricedCorridor.id,
    },
  });

  return {
    ok: true,
    result: {
      transferId: transfer.id,
      corridor: {
        id: pricedCorridor.id,
        fromCcy: pricedCorridor.fromCcy,
        toCcy: pricedCorridor.toCcy,
        status: pricedCorridor.status,
        spreadBps: pricedCorridor.spreadBps,
        ...(pricedCorridor.perTxCapUsd != null
          ? { perTxCapUsd: pricedCorridor.perTxCapUsd }
          : {}),
      },
      quote: {
        rate: quote.rate,
        spreadBps: quote.spreadBps,
        toAmount: quote.toAmount,
        expiresAt: quote.expiresAt,
      },
      amountUsd,
      tier,
      recipientGets: { amount: quote.toAmount, currency: pricedCorridor.toCcy },
    },
  };
}

// ─── Confirm ──────────────────────────────────────────────────────────────

/**
 * Confirm a previously-quoted cross-border transfer. Loads the transfer
 * (ownership-checked), then drives the state machine off the `quoted` quote:
 *
 *   quoted → debited → onchain_settling
 *
 * From there the destination fiat-out differs by corridor:
 *   • LIVE NG corridor, routes via the Linq off-ramp. The actual Linq
 *     payout fires from the broadcast-confirm hook after finality; here we
 *     mark the intent to route via Linq and leave the transfer at
 *     `onchain_settling`. See the clearly-marked integration point.
 *   • PARTNER corridors, advance to `fiat_out_pending` as a documented
 *     stub (no live PSP wired yet).
 *
 * Commit-point semantics (transfers.ts): nothing here crosses the on-chain
 * commit point. The transfer is left at `onchain_settling` (pre-commit) for
 * NG until the broadcast-confirm hook fires `confirm_onchain`; partner
 * corridors are advanced through to `fiat_out_pending` to document the stub
 * payout (in production the same broadcast-confirm hook gates this).
 */
export async function confirmCrossBorder(
  userId: number,
  transferId: string
): Promise<ConfirmCrossBorderResult> {
  const id = (transferId ?? "").trim();
  if (!id) {
    return { ok: false, code: "BAD_INPUT", message: "transferId is required." };
  }

  const transfer = await getTransfer(id);
  if (!transfer) {
    return { ok: false, code: "NOT_FOUND", message: "Transfer not found." };
  }
  // Ownership check, a transfer can only be confirmed by its owner.
  if (transfer.userId !== String(userId)) {
    return { ok: false, code: "FORBIDDEN", message: "You don't own this transfer." };
  }
  if (transfer.kind !== "cross_border") {
    return {
      ok: false,
      code: "BAD_INPUT",
      message: "This endpoint only confirms cross-border transfers.",
    };
  }

  // Drive: quoted → debited. Debiting marks the user as committed to
  // sending (their funds are reserved); this counts against the monthly cap
  // (COUNTED_STATES). A non-`quoted` transfer fails the transition guard.
  const debited = await advanceTransfer(id, "debit", {
    reason: "cross-border confirm: debit",
  });
  if (!debited.ok) {
    return mapAdvanceFailure(debited.code);
  }

  // Drive: debited → onchain_settling. iOS broadcasts the gasless USDsui
  // PTB to the corridor's treasury; the broadcast-confirm hook later fires
  // `confirm_onchain` (crossing the commit point) with the on-chain digest.
  const settling = await advanceTransfer(id, "start_onchain", {
    reason: "cross-border confirm: on-chain leg broadcast",
  });
  if (!settling.ok) {
    return mapAdvanceFailure(settling.code);
  }

  const corridor = getCorridor(
    (transfer.metadata?.fromCountry as CountryCode) ?? ("US" as CountryCode),
    (transfer.metadata?.toCountry as CountryCode) ?? ("NG" as CountryCode)
  );

  // ── Destination fiat-out routing ────────────────────────────────────
  if (transfer.provider === "linq" || corridor?.toCountry === "NG") {
    // INTEGRATION POINT (LIVE NG corridor → Linq):
    //   The NGN fiat-out is the Linq off-ramp (web/lib/linq.ts +
    //   web/app/api/offramp/linq/*). The route contract here is kept STABLE
    //   for iOS, the swap is internal-only. We leave the transfer at
    //   `onchain_settling` and let the on-chain-confirm hook advance it.
    //
    //   TODO(linq): wire the Linq payout into the `confirm_onchain` handler.
    //   Because Linq watches its OWN deposit wallet (no Talise treasury),
    //   the on-chain leg for this corridor must send USDSUI to a Linq order's
    //   `walletAddress` (lib/linq.createOrder) rather than to a treasury;
    //   Linq then pays the bank and reports via webhook/status. Until that
    //   leg is generalized off `transfers`, this branch is a no-op that keeps
    //   the machine at `onchain_settling` and the route response unchanged.
    return { ok: true, state: settling.transfer.state, transferId: id };
  }

  // PARTNER corridors, documented stub. No live PSP payout is wired, so we
  // advance the machine through the on-chain commit to `fiat_out_pending`
  // to model the intended terminal-adjacent state. In production the same
  // broadcast-confirm hook gates `confirm_onchain` on real finality; the
  // stub here advances it inline so the flow is observable end-to-end.
  const confirmed = await advanceTransfer(id, "confirm_onchain", {
    reason: "cross-border confirm: partner-stub on-chain settle",
  });
  if (!confirmed.ok) {
    return mapAdvanceFailure(confirmed.code);
  }
  const fiatOut = await advanceTransfer(id, "start_fiat_out", {
    reason: "cross-border confirm: partner-stub fiat-out submitted",
  });
  if (!fiatOut.ok) {
    return mapAdvanceFailure(fiatOut.code);
  }
  return { ok: true, state: fiatOut.transfer.state, transferId: id };
}

/** Map an `advanceTransfer` failure code onto the confirm route contract. */
function mapAdvanceFailure(
  code: "not_found" | "illegal_transition" | "terminal" | "conflict"
): ConfirmCrossBorderResult {
  switch (code) {
    case "not_found":
      return { ok: false, code: "NOT_FOUND", message: "Transfer not found." };
    case "illegal_transition":
    case "terminal":
      return {
        ok: false,
        code: "CONFLICT",
        message: "This transfer can't be confirmed from its current state.",
      };
    case "conflict":
      return {
        ok: false,
        code: "CONFLICT",
        message: "This transfer changed concurrently; please retry.",
      };
    default:
      return { ok: false, code: "INTERNAL", message: "Transfer could not be advanced." };
  }
}

// Re-export the record type so route handlers can type their reads without
// importing transfers.ts directly.
export type { TransferRecord };
