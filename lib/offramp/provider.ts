import "server-only";

import { randomUUID } from "node:crypto";

import {
  CORRIDOR_DEGRADED_MESSAGE,
  LIVE_PROVIDER_IDS,
  corridorProviderOrder,
  stubsAllowed,
  type ProviderId,
} from "./config";
import {
  ProviderRequestError,
  ProviderUnavailableError,
  checkBreaker,
  isProviderSideFailure,
  reportProviderOutcome,
  type BreakerVerdict,
} from "./breaker";
import {
  claimIntent,
  completeIntent,
  fingerprintKey,
  intentKey,
  recordAttempt,
  releaseIntent,
} from "./store";
import type {
  PayoutAdapter,
  PayoutCurrency,
  PayoutDestination,
  PayoutResult,
  PayoutStatusResult,
  Quote,
  QuoteRequest,
} from "./types";

/**
 * The provider abstraction: corridor → ORDERED providers, with health.
 *
 * `registry.ts` used to be a flat `currency → one adapter` map whose non-NGN
 * entries were mocks that report "pending" forever. That shape cannot express
 * the two things a payout rail actually needs:
 *
 *   1. A corridor may have a PRIMARY and one or more FALLBACK providers, chosen
 *      by configuration, so an incident is a routing change and not an outage.
 *   2. A provider can be UNUSABLE right now (unconfigured, disabled, circuit
 *      open) and the corridor must degrade with a clear reason instead of
 *      taking the user's money and hoping.
 *
 * A `PayoutProvider` is a `PayoutAdapter` plus the two facts the router needs:
 * which corridors it serves, and whether it is actually usable.
 */

// ─── Provider contract ──────────────────────────────────────────────────────

export type ProviderReadiness =
  | { ok: true }
  | { ok: false; reason: string };

export interface PayoutProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  /** Every destination currency this provider can pay out. */
  readonly currencies: readonly PayoutCurrency[];
  /**
   * False for the mock corridor adapters. A non-live provider is never selected
   * unless `OFFRAMP_ALLOW_STUBS=true` outside production, because a stub that
   * reports "pending" forever is indistinguishable to a user from a payout that
   * silently died.
   */
  readonly live: boolean;

  /** Credentials/config present? Checked before every selection. */
  configured(): ProviderReadiness;

  quote(req: QuoteRequest): Promise<Quote>;
  initiatePayout(req: PayoutSubmission): Promise<PayoutResult>;
  status(providerReference: string): Promise<PayoutStatusResult>;
}

/** What `initiatePayout` needs, with the idempotency key made explicit. */
export interface PayoutSubmission {
  quoteId?: string;
  destination: PayoutDestination;
  toCcy: PayoutCurrency;
  /** Destination fiat the recipient must receive, major units. */
  toAmount: number;
  /** USD/USDsui leaving the user (at par). */
  usdAmount: number;
  /**
   * IDEMPOTENCY KEY. Re-submitting with the same value MUST return the original
   * payout, never a second one. Non-optional on purpose: making this a required
   * field is what stops a retry-after-timeout from double-paying.
   */
  idempotencyKey: string;
  /** Our own row id, for provider-side cross-referencing. */
  reference: string;
  remarks?: string;
}

/** Adapt a legacy stub `PayoutAdapter` into a (non-live) `PayoutProvider`. */
export function fromAdapter(adapter: PayoutAdapter): PayoutProvider {
  return {
    id: adapter.id as ProviderId,
    displayName: adapter.displayName,
    currencies: [adapter.currency],
    live: LIVE_PROVIDER_IDS.has(adapter.id as ProviderId),
    configured() {
      return LIVE_PROVIDER_IDS.has(adapter.id as ProviderId)
        ? { ok: true }
        : { ok: false, reason: `"${adapter.id}" is a stub adapter with no live partner integration` };
    },
    quote: (req) => adapter.quote(req),
    initiatePayout: (req) =>
      adapter.initiatePayout({
        quoteId: req.quoteId ?? "",
        destination: req.destination,
        reference: req.idempotencyKey,
        remarks: req.remarks,
      }),
    status: (ref) => adapter.status(ref),
  };
}

// ─── Registration ───────────────────────────────────────────────────────────

const _providers = new Map<ProviderId, PayoutProvider>();

/** Register (or replace) a provider implementation. */
export function registerProvider(p: PayoutProvider): void {
  _providers.set(p.id, p);
}

export function getProvider(id: ProviderId): PayoutProvider | undefined {
  return _providers.get(id);
}

export function listProviders(): PayoutProvider[] {
  return [...(_providers.values() as Iterable<PayoutProvider>)];
}

// ─── Corridor resolution ────────────────────────────────────────────────────

export interface ResolvedCandidate {
  id: ProviderId;
  provider?: PayoutProvider;
  /** Position in the corridor's order: 0 = primary. */
  rank: number;
  usable: boolean;
  /** Why this candidate is not usable (unregistered / unconfigured / open). */
  reason?: string;
  breaker?: BreakerVerdict;
}

export interface CorridorResolution {
  currency: PayoutCurrency;
  candidates: ResolvedCandidate[];
  /** The provider to use, or undefined when the corridor is degraded. */
  selected?: PayoutProvider;
  /** True when the corridor has providers configured but none usable NOW. */
  degraded: boolean;
}

/**
 * Resolve a corridor to the provider that should serve it right now, evaluating
 * every candidate in configured order so an operator can see exactly why a
 * corridor is degraded rather than guessing from a 502.
 */
export async function resolveCorridor(
  ccy: PayoutCurrency
): Promise<CorridorResolution> {
  const order = corridorProviderOrder(ccy);
  const candidates: ResolvedCandidate[] = [];
  let selected: PayoutProvider | undefined;

  for (let rank = 0; rank < order.length; rank++) {
    const id = order[rank];
    const provider = _providers.get(id);
    if (!provider) {
      candidates.push({ id, rank, usable: false, reason: "provider not registered" });
      continue;
    }
    if (!provider.live && !stubsAllowed()) {
      candidates.push({
        id,
        provider,
        rank,
        usable: false,
        reason: "stub provider (no live partner); set OFFRAMP_ALLOW_STUBS=true in dev to use it",
      });
      continue;
    }
    const ready = provider.configured();
    if (!ready.ok) {
      candidates.push({ id, provider, rank, usable: false, reason: ready.reason });
      continue;
    }
    const breaker = await checkBreaker(id);
    if (!breaker.allow) {
      candidates.push({ id, provider, rank, usable: false, reason: breaker.reason, breaker });
      continue;
    }
    candidates.push({ id, provider, rank, usable: true, breaker });
    if (!selected) selected = provider;
  }

  return {
    currency: ccy,
    candidates,
    selected,
    degraded: !selected && order.length > 0,
  };
}

/**
 * The provider for a corridor, or a typed failure. Callers turn `degraded` into
 * a 503 with {@link CORRIDOR_DEGRADED_MESSAGE}: refusing BEFORE the user sends
 * anything is the only failure on this path that costs nobody money.
 */
export async function requireProvider(
  ccy: PayoutCurrency
): Promise<PayoutProvider> {
  const res = await resolveCorridor(ccy);
  if (res.selected) return res.selected;
  const detail = res.candidates
    .map((c) => `${c.id}: ${c.reason ?? "unusable"}`)
    .join("; ");
  throw new ProviderUnavailableError(
    res.candidates.length === 0
      ? `no payout provider configured for ${ccy}`
      : `${ccy} corridor degraded (${detail})`,
    res.candidates[0]?.id ?? "none",
    detail
  );
}

// ─── Idempotent submission with failover ────────────────────────────────────

export interface SubmitPayoutInput {
  userId: string | number;
  toCcy: PayoutCurrency;
  toAmount: number;
  usdAmount: number;
  destination: PayoutDestination;
  /**
   * Client-supplied idempotency key. When absent we derive a short-window
   * fingerprint of the intent so a retry still collapses; see
   * `store.fingerprintKey` for the tradeoff.
   */
  clientIdempotencyKey?: string;
  remarks?: string;
}

export interface SubmitPayoutResult {
  providerId: ProviderId;
  providerReference: string;
  status: PayoutResult["status"];
  /** Our attempt-ledger id. */
  attemptId: string;
  /** True when this call replayed a previously-created payout. */
  replayed: boolean;
}

/**
 * Submit a fiat-out payout with idempotency, failover, and ledgering.
 *
 * Order of operations is deliberate:
 *
 *  1. CLAIM the idempotency key first. If somebody already claimed it we replay
 *     their answer and submit NOTHING. This is what makes a client retry after a
 *     timeout safe: without it the retry creates a second payout order.
 *  2. Try providers in configured order. A PROVIDER-SIDE failure (5xx/timeout)
 *     moves to the next provider AND counts against the failing provider's
 *     health. A REQUEST error (bad account number) does not fail over, because
 *     every provider will reject it too and retrying just spams the corridor.
 *  3. Ledger the attempt as soon as a provider accepts, so an attempt can never
 *     exist at a provider without existing here.
 *  4. On total failure, RELEASE the claim so the user's next attempt is not
 *     replayed into a dead end.
 */
export async function submitPayout(
  input: SubmitPayoutInput
): Promise<SubmitPayoutResult> {
  const corridor = input.toCcy;
  const key = input.clientIdempotencyKey
    ? intentKey({ userId: input.userId, corridor, clientKey: input.clientIdempotencyKey })
    : fingerprintKey({
        userId: input.userId,
        corridor,
        amount: input.toAmount,
        destination: destinationFingerprint(input.destination),
      });

  const resolution = await resolveCorridor(corridor);
  if (!resolution.selected) {
    const detail = resolution.candidates
      .map((c) => `${c.id}: ${c.reason ?? "unusable"}`)
      .join("; ");
    throw new ProviderUnavailableError(CORRIDOR_DEGRADED_MESSAGE, corridor, detail);
  }

  const claim = await claimIntent({
    key,
    userId: input.userId,
    provider: resolution.selected.id,
    corridor,
  });
  if (!claim.claimed) {
    const prev = claim.existing;
    if (prev.providerRef) {
      return {
        providerId: prev.provider as ProviderId,
        providerReference: prev.providerRef,
        status: "pending",
        attemptId: prev.ourRef ?? prev.key,
        replayed: true,
      };
    }
    // Claimed but never completed: a concurrent request is mid-flight. Refusing
    // is correct, retrying would race it into a duplicate payout.
    throw new ProviderUnavailableError(
      "A cash-out with the same details is already being processed.",
      prev.provider,
      "duplicate_in_flight"
    );
  }

  const usable = resolution.candidates.filter((c) => c.usable && c.provider);
  const failures: string[] = [];

  for (const candidate of usable) {
    const provider = candidate.provider!;
    const attemptId = randomUUID();
    try {
      const result = await provider.initiatePayout({
        destination: input.destination,
        toCcy: corridor,
        toAmount: input.toAmount,
        usdAmount: input.usdAmount,
        idempotencyKey: key,
        reference: attemptId,
        remarks: input.remarks,
      });
      await reportProviderOutcome(provider.id, true);
      // Ledger BEFORE returning: a payout that exists at the provider but not
      // here is unreconcilable and unrefundable.
      await recordAttempt({
        id: attemptId,
        userId: input.userId,
        provider: provider.id,
        corridor,
        usdAmount: input.usdAmount,
        destAmount: input.toAmount,
        providerRef: result.providerReference,
        state: result.status === "settled" ? "settled" : "submitted",
      });
      await completeIntent({
        key,
        ourRef: attemptId,
        providerRef: result.providerReference,
        response: {
          providerId: provider.id,
          providerReference: result.providerReference,
          status: result.status,
          attemptId,
        },
      });
      return {
        providerId: provider.id,
        providerReference: result.providerReference,
        status: result.status,
        attemptId,
        replayed: false,
      };
    } catch (e) {
      const msg = (e as Error).message ?? "unknown error";
      failures.push(`${provider.id}: ${msg}`);
      if (e instanceof ProviderRequestError) {
        // The request itself is bad. Release the claim (the user must fix the
        // input and resubmit) and do NOT fail over.
        await releaseIntent(key, "provider rejected the request");
        throw e;
      }
      if (isProviderSideFailure(e)) {
        await reportProviderOutcome(provider.id, false, msg);
      }
      // Fall through to the next configured provider.
    }
  }

  await releaseIntent(key, "all providers failed");
  throw new ProviderUnavailableError(
    CORRIDOR_DEGRADED_MESSAGE,
    resolution.selected.id,
    failures.join("; ") || "no usable provider"
  );
}

/** Stable, non-sensitive fingerprint of a destination for intent bucketing. */
function destinationFingerprint(d: PayoutDestination): string {
  return d.kind === "bank"
    ? `bank:${d.bankCode}:${d.accountNumber}`
    : `alias:${d.aliasType}:${d.alias}`;
}
