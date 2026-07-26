import "server-only";

/**
 * Off-ramp (fiat-out) CONFIGURATION. One place that answers:
 *
 *   • which provider serves a corridor, and in what order (primary → fallback)
 *   • where each provider's API lives (no hostnames baked into code)
 *   • whether the cash-out product is open (FAIL CLOSED)
 *   • how the circuit breaker should behave
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Talise had exactly one real fiat-out rail in the world (Linq, NGN) and its
 * hostname was a literal in `lib/linq.ts`. A single provider incident was a
 * 100% corridor outage with no way to redirect traffic and no way to stop
 * issuing deposit addresses into a broken rail. Everything about the payout
 * provider is now data, so a corridor can be re-pointed, degraded, or shut off
 * with an env change instead of a deploy.
 *
 * ENV
 * ---
 *   FEATURE_CASHOUT            "true" to OPEN NGN bank cash-out. Anything else
 *                              (including unset) keeps it CLOSED. Fail closed.
 *   LINQ_BASE_URL              REQUIRED for the Linq rail. No default: the old
 *                              free-tier Koyeb hostname is gone from the code.
 *   LINQ_API_KEY               Linq X-API-Key.
 *   LINQ_WEBHOOK_SECRET        HMAC key for Linq webhooks.
 *   BRIDGE_API_KEY             Bridge.xyz Api-Key (see lib/bridge/client.ts).
 *   BRIDGE_API_BASE            Bridge base URL override.
 *   OFFRAMP_PROVIDERS_<CCY>    Comma-ordered provider ids for a corridor, e.g.
 *                              OFFRAMP_PROVIDERS_USD="bridge".  First entry is
 *                              primary, the rest are fallbacks in order.
 *   OFFRAMP_PROVIDER_DISABLED  Comma list of provider ids to hard-disable (an
 *                              ops kill switch during an incident).
 *   OFFRAMP_ALLOW_STUBS        "true" to let the mock/stub corridor adapters be
 *                              selected. NEVER set this in production: a stub
 *                              reports "pending" forever, which to a user is
 *                              indistinguishable from a payout that will never
 *                              arrive.
 *   OFFRAMP_BREAKER_*          Circuit-breaker tuning (see BREAKER below).
 */

import type { PayoutCurrency } from "./types";

// ─── Provider identity ──────────────────────────────────────────────────────

/**
 * Every payout provider Talise can hold a contract with. Adding a value here
 * is the ONLY place a new rail needs to be named; the registry maps corridors
 * onto these ids and `provider.ts` resolves the id to an implementation.
 */
export type ProviderId =
  | "linq" // NGN bank payout (live)
  | "bridge" // USD (ACH/wire) + EUR (SEPA) payout via bridge.xyz (live, keyed)
  | "mpesa-ke" // stub
  | "paynow-sg" // stub
  | "zengin-jp" // stub
  | "generic-bank-ghs" // stub
  | "generic-bank-zar"; // stub

/** Provider ids that are real integrations (as opposed to mock scaffolding). */
export const LIVE_PROVIDER_IDS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "linq",
  "bridge",
]);

// ─── Product gate (FAIL CLOSED) ─────────────────────────────────────────────

/**
 * Bank cash-out product gate.
 *
 * FAIL CLOSED: open ONLY when `FEATURE_CASHOUT` is explicitly an affirmative
 * value. The previous form (`!== "false"`) opened the rail whenever the env var
 * was unset, misspelled, or lost during a project migration, i.e. an ops
 * mistake silently re-opened a money rail that had been shut off because the
 * provider was 500-ing without refunding. For a payout rail the safe default is
 * "closed"; a wrongly-closed rail costs a support ticket, a wrongly-open one
 * costs a user's money.
 */
export function cashoutOpen(): boolean {
  const v = process.env.FEATURE_CASHOUT?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

/** User-facing copy when cash-out is gated closed. */
export const CASHOUT_CLOSED_MESSAGE =
  "Cash-out to bank isn't available yet, it's coming soon. Your balance is untouched.";

/** User-facing copy when the corridor's providers are all unavailable. */
export const CORRIDOR_DEGRADED_MESSAGE =
  "Bank cash-out is temporarily unavailable. Nothing has been taken from your balance, please try again later.";

/** Whether the mock corridor adapters may be selected (dev only). */
export function stubsAllowed(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.OFFRAMP_ALLOW_STUBS?.trim().toLowerCase() === "true";
}

/** Ops kill switch: provider ids an operator has hard-disabled. */
export function disabledProviders(): ReadonlySet<string> {
  const raw = process.env.OFFRAMP_PROVIDER_DISABLED ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

// ─── Provider base URLs ─────────────────────────────────────────────────────

/**
 * Hostnames that mean "this is somebody's free-tier hobby deployment". A real
 * money rail must not sit behind one: no SLA, cold starts, and the hostname
 * itself can be reclaimed. We do not block on this (the Nigerian corridor is
 * live and this is the partner's own infrastructure) but we log a loud warning
 * once per process so it can never be forgotten again.
 */
const FREE_TIER_HOST_MARKERS = [
  ".koyeb.app",
  ".onrender.com",
  ".herokuapp.com",
  ".vercel.app",
  ".fly.dev",
  ".railway.app",
  ".ngrok.io",
  ".ngrok-free.app",
  ".trycloudflare.com",
];

const _warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(message);
}

export type ProviderBaseUrl =
  | { ok: true; baseUrl: string }
  | { ok: false; reason: string };

/**
 * Resolve + validate a provider base URL from env. Returns a typed failure
 * instead of throwing so callers can turn it into a clean 503 rather than a
 * 500. Requires https in production (a payout API over http would leak bank
 * coordinates and account names in transit).
 */
export function providerBaseUrl(
  provider: ProviderId,
  envVar: string,
  opts?: { defaultUrl?: string }
): ProviderBaseUrl {
  const raw = process.env[envVar]?.trim() || opts?.defaultUrl;
  if (!raw) {
    return {
      ok: false,
      reason: `${envVar} is not set (required for the "${provider}" payout rail)`,
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `${envVar} is not a valid URL` };
  }
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
    return { ok: false, reason: `${envVar} must be https in production` };
  }
  const host = url.host.toLowerCase();
  if (FREE_TIER_HOST_MARKERS.some((m) => host.endsWith(m))) {
    warnOnce(
      `free-tier:${provider}:${host}`,
      `[offramp/config] provider "${provider}" points at ${host}, a free-tier PaaS hostname. ` +
        `This is a REAL MONEY payout rail with no SLA behind it; move it to a contracted endpoint (${envVar}).`
    );
  }
  // Normalize: strip trailing slashes so callers can concatenate paths.
  return { ok: true, baseUrl: raw.replace(/\/+$/, "") };
}

// ─── Corridor → ordered provider list ───────────────────────────────────────

/**
 * Built-in corridor routing. The FIRST entry is the primary; later entries are
 * fallbacks tried in order when the primary is unhealthy or refuses.
 *
 * Reality check, deliberately encoded honestly:
 *   • NGN has ONE provider. There is no fallback because Talise has not signed
 *     a second Nigerian payout partner. Failover cannot be invented in code;
 *     what the code CAN do is stop issuing deposit addresses into a dead rail
 *     and say so, instead of taking the user's money first.
 *   • USD/EUR have Bridge only today, but Bridge is a real, keyed rail, so the
 *     multi-provider machinery is exercised by a live integration rather than a
 *     mock.
 *   • Every other corridor is stubs-only and therefore UNROUTABLE unless
 *     `OFFRAMP_ALLOW_STUBS=true` in development.
 */
const DEFAULT_CORRIDOR_PROVIDERS: Partial<Record<PayoutCurrency, ProviderId[]>> = {
  NGN: ["linq"],
  USD: ["bridge"],
  EUR: ["bridge"],
  KES: ["mpesa-ke"],
  GHS: ["generic-bank-ghs"],
  ZAR: ["generic-bank-zar"],
  JPY: ["zengin-jp"],
  SGD: ["paynow-sg"],
};

const ALL_PROVIDER_IDS: ReadonlySet<string> = new Set<string>([
  "linq",
  "bridge",
  "mpesa-ke",
  "paynow-sg",
  "zengin-jp",
  "generic-bank-ghs",
  "generic-bank-zar",
]);

/**
 * The ordered provider list for a corridor. `OFFRAMP_PROVIDERS_<CCY>` overrides
 * the built-in order entirely, which is how an operator fails a corridor over
 * to a second provider (or drains it to none) WITHOUT a deploy. Unknown ids in
 * the override are dropped with a warning rather than silently routing money to
 * nothing.
 */
export function corridorProviderOrder(ccy: PayoutCurrency): ProviderId[] {
  const override = process.env[`OFFRAMP_PROVIDERS_${ccy}`]?.trim();
  const ids = override
    ? override
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : (DEFAULT_CORRIDOR_PROVIDERS[ccy] ?? []);

  const out: ProviderId[] = [];
  for (const id of ids) {
    if (!ALL_PROVIDER_IDS.has(id)) {
      warnOnce(
        `unknown-provider:${ccy}:${id}`,
        `[offramp/config] OFFRAMP_PROVIDERS_${ccy} names unknown provider "${id}", ignoring it.`
      );
      continue;
    }
    if (!out.includes(id as ProviderId)) out.push(id as ProviderId);
  }
  return out;
}

// ─── Circuit breaker tuning ─────────────────────────────────────────────────

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/**
 * Breaker thresholds. Deliberately conservative for a payout rail: three
 * consecutive infrastructure failures is already enough evidence that the next
 * user should not be handed a deposit address, and a 2-minute cooldown means a
 * transient blip self-heals without ops involvement.
 */
export const BREAKER = {
  /** Consecutive provider-side failures that trip the circuit OPEN. */
  get failureThreshold(): number {
    return intEnv("OFFRAMP_BREAKER_FAILURES", 3);
  },
  /** How long a tripped circuit stays OPEN before a single probe is allowed. */
  get cooldownMs(): number {
    return intEnv("OFFRAMP_BREAKER_COOLDOWN_MS", 120_000);
  },
  /** Consecutive successes in HALF_OPEN needed to close the circuit again. */
  get probeSuccesses(): number {
    return intEnv("OFFRAMP_BREAKER_PROBE_SUCCESSES", 1);
  },
  /** In-process cache TTL for the shared (DB) breaker state. */
  get cacheTtlMs(): number {
    return intEnv("OFFRAMP_BREAKER_CACHE_TTL_MS", 5_000);
  },
} as const;

// ─── Reconciliation tuning ──────────────────────────────────────────────────

/**
 * How long after creation an un-funded order is considered dead. Linq's own
 * deposit window is 10 minutes; we allow generous slack so a slow client that
 * did fund the order is never expired out from under it.
 */
export const DEPOSIT_WINDOW_MS = 10 * 60 * 1000;
export const DEPOSIT_WINDOW_SLACK_MS = 20 * 60 * 1000;

/** Age past which a still-non-terminal FUNDED payout is escalated as stuck. */
export function strandedAfterMs(): number {
  return intEnv("OFFRAMP_STRANDED_AFTER_MS", 6 * 60 * 60 * 1000);
}
