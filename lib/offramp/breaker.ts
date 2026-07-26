import "server-only";

import { BREAKER, disabledProviders } from "./config";
import {
  markProviderHalfOpen,
  readProviderHealth,
  recordProviderFailure,
  recordProviderSuccess,
  type BreakerState,
} from "./store";

/**
 * Circuit breaker for fiat-out providers.
 *
 * THE FAILURE THIS EXISTS TO STOP
 * -------------------------------
 * Talise's Nigerian rail once started returning 500s from its downstream
 * provider and did not auto-refund. The application kept behaving as if nothing
 * was wrong: every user who tapped "cash out" got a fresh deposit address,
 * sent real USDsui to it, and got neither naira nor a refund. Each additional
 * request during the incident created a NEW stranded user.
 *
 * A breaker converts "the rail is broken" from something a human notices hours
 * later into something the request path knows within three failures. Once the
 * circuit is OPEN we refuse BEFORE the user parts with any money, which is the
 * only failure mode on this path that costs nothing.
 *
 * DESIGN NOTES
 * ------------
 *  • State is SHARED (Postgres), not per-process. Vercel runs many isolated
 *    instances; a per-process counter means instance A notices the outage while
 *    instance B keeps stranding users.
 *  • Reads are cached in-process for a few seconds so the hot path costs at most
 *    one small SELECT per instance per window.
 *  • Only PROVIDER-SIDE failures count. A user typing a bad account number is
 *    not evidence the rail is down; counting 4xx would let one bad input take a
 *    whole corridor offline.
 *  • The breaker FAILS OPEN on its own errors. If the health table is
 *    unreachable we allow the call: the breaker is a safety improvement, and it
 *    must never become a new single point of failure that blocks a healthy rail.
 *    (The money-safety guarantees do not depend on it, they are enforced by
 *    idempotency + reconciliation.)
 */

// ─── Failure classification ─────────────────────────────────────────────────

/**
 * A provider error that should count against provider health, as opposed to a
 * caller/validation error that should not. `retryable` tells the failover layer
 * whether trying the next provider makes sense.
 */
export class ProviderTransportError extends Error {
  readonly kind = "transport" as const;
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number = 0
  ) {
    super(message);
    this.name = "ProviderTransportError";
  }
}

/** The provider rejected the REQUEST (validation, unknown bank, over-limit). */
export class ProviderRequestError extends Error {
  readonly kind = "request" as const;
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

/** No provider could be used for the corridor (circuit open / none configured). */
export class ProviderUnavailableError extends Error {
  readonly kind = "unavailable" as const;
  readonly code = "PROVIDER_UNAVAILABLE" as const;
  constructor(
    message: string,
    readonly provider: string,
    readonly detail?: string
  ) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

/** True when `e` means "the rail is unhealthy", not "the request was bad". */
export function isProviderSideFailure(e: unknown): boolean {
  if (e instanceof ProviderRequestError) return false;
  if (e instanceof ProviderTransportError) return true;
  if (e instanceof ProviderUnavailableError) return false;
  const msg = (e as Error)?.message ?? "";
  // Heuristic for the legacy string-thrown errors in lib/linq.ts: transport +
  // 5xx signatures count, anything else is treated as caller-side so a typo
  // can't trip the breaker.
  return /network error|timed? ?out|abort|ECONN|ETIMEDOUT|socket|fetch failed|HTTP 5\d\d|\b5\d\d\b/i.test(
    msg
  );
}

/** Map an HTTP status onto the right error class for a provider call. */
export function providerErrorForStatus(
  provider: string,
  status: number,
  message: string
): ProviderTransportError | ProviderRequestError {
  // 408/425/429 are "come back later" and 5xx is "we are broken": both are
  // provider-side. Everything else in 4xx is the caller's fault.
  if (status === 0 || status >= 500 || status === 408 || status === 425 || status === 429) {
    return new ProviderTransportError(message, provider, status);
  }
  return new ProviderRequestError(message, provider, status);
}

// ─── Gate ───────────────────────────────────────────────────────────────────

export interface BreakerVerdict {
  /** Whether a call to this provider should be attempted at all. */
  allow: boolean;
  state: BreakerState | "disabled";
  /** Set when `allow` is true and this is the single cooldown probe. */
  probe: boolean;
  /** Operator-facing explanation. */
  reason?: string;
  /** Epoch ms when an OPEN circuit will next allow a probe. */
  retryAtMs?: number;
}

type CacheEntry = { at: number; verdict: BreakerVerdict };
const _cache = new Map<string, CacheEntry>();

/**
 * Should we call `provider` right now?
 *
 * OPEN circuits are refused until the cooldown elapses, at which point exactly
 * one caller wins the `markProviderHalfOpen` race and probes the rail. If the
 * probe fails, the cooldown restarts; if it succeeds, the circuit closes.
 */
export async function checkBreaker(provider: string): Promise<BreakerVerdict> {
  if (disabledProviders().has(provider.toLowerCase())) {
    return {
      allow: false,
      state: "disabled",
      probe: false,
      reason: `provider "${provider}" is disabled by OFFRAMP_PROVIDER_DISABLED`,
    };
  }

  const cached = _cache.get(provider);
  // Cacheable: a DENY (saves the DB read during an incident, exactly when load
  // spikes) and a plain CLOSED allow (saves a SELECT on every provider call).
  // A `probe` verdict is NEVER cached: the half-open probe is a single-use token
  // and reusing it would send a burst at a rail we believe is broken.
  if (
    cached &&
    !cached.verdict.probe &&
    Date.now() - cached.at < BREAKER.cacheTtlMs
  ) {
    return cached.verdict;
  }

  let health;
  try {
    health = await readProviderHealth(provider);
  } catch (e) {
    // Fail open, see the module note: the breaker must not become a new SPOF.
    console.warn(
      `[offramp/breaker] health read failed for ${provider}, allowing the call:`,
      (e as Error).message
    );
    return { allow: true, state: "closed", probe: false };
  }

  if (!health || health.state === "closed") {
    const verdict: BreakerVerdict = { allow: true, state: "closed", probe: false };
    _cache.set(provider, { at: Date.now(), verdict });
    return verdict;
  }

  if (health.state === "half_open") {
    // Another instance is already probing. Refuse rather than pile onto a rail
    // we believe is broken.
    const verdict: BreakerVerdict = {
      allow: false,
      state: "half_open",
      probe: false,
      reason: `provider "${provider}" is being probed after an outage`,
      retryAtMs: (health.openedAt ?? Date.now()) + BREAKER.cooldownMs,
    };
    _cache.set(provider, { at: Date.now(), verdict });
    return verdict;
  }

  // OPEN.
  const openedAt = health.openedAt ?? health.lastFailureAt ?? Date.now();
  const retryAtMs = openedAt + BREAKER.cooldownMs;
  if (Date.now() < retryAtMs) {
    const verdict: BreakerVerdict = {
      allow: false,
      state: "open",
      probe: false,
      reason:
        `provider "${provider}" circuit is OPEN after ${health.consecutiveFailures} ` +
        `consecutive failures (${health.lastReason ?? "no reason recorded"})`,
      retryAtMs,
    };
    _cache.set(provider, { at: Date.now(), verdict });
    return verdict;
  }

  // Cooldown elapsed: exactly one caller wins the probe.
  let won = false;
  try {
    won = await markProviderHalfOpen(provider);
  } catch {
    won = true; // DB hiccup, allow one call rather than pinning the rail shut.
  }
  if (won) {
    _cache.delete(provider);
    return {
      allow: true,
      state: "half_open",
      probe: true,
      reason: `probing "${provider}" after cooldown`,
    };
  }
  const verdict: BreakerVerdict = {
    allow: false,
    state: "half_open",
    probe: false,
    reason: `provider "${provider}" is being probed by another instance`,
    retryAtMs: retryAtMs + BREAKER.cooldownMs,
  };
  _cache.set(provider, { at: Date.now(), verdict });
  return verdict;
}

/** Record a provider interaction outcome. Never throws. */
export async function reportProviderOutcome(
  provider: string,
  ok: boolean,
  reason?: string
): Promise<void> {
  _cache.delete(provider);
  try {
    if (ok) {
      await recordProviderSuccess(provider, BREAKER.probeSuccesses);
    } else {
      await recordProviderFailure(
        provider,
        reason ?? "unspecified provider failure",
        BREAKER.failureThreshold
      );
      console.warn(`[offramp/breaker] ${provider} failure recorded: ${reason ?? "?"}`);
    }
  } catch (e) {
    console.warn(
      `[offramp/breaker] could not record ${ok ? "success" : "failure"} for ${provider}:`,
      (e as Error).message
    );
  }
}

/**
 * Run `fn` behind the breaker for `provider`.
 *
 * IMPORTANT: this only guards and observes. It does NOT retry, because a payout
 * submission is not safely retryable without an idempotency key, and blind
 * retries are exactly how a timeout turns into a double payment. Retry/failover
 * decisions belong to `provider.ts`, which has the idempotency claim in hand.
 */
export async function withBreaker<T>(
  provider: string,
  fn: () => Promise<T>,
  opts?: { classify?: (e: unknown) => boolean }
): Promise<T> {
  const verdict = await checkBreaker(provider);
  if (!verdict.allow) {
    throw new ProviderUnavailableError(
      verdict.reason ?? `provider "${provider}" is unavailable`,
      provider,
      verdict.state
    );
  }
  try {
    const out = await fn();
    await reportProviderOutcome(provider, true);
    return out;
  } catch (e) {
    const providerSide = (opts?.classify ?? isProviderSideFailure)(e);
    if (providerSide) {
      await reportProviderOutcome(provider, false, (e as Error).message);
    } else {
      // A clean 4xx proves the rail is UP, so it counts as a success for health
      // purposes. Without this a corridor full of typo'd account numbers would
      // never close a half-open circuit.
      await reportProviderOutcome(provider, true);
    }
    throw e;
  }
}
