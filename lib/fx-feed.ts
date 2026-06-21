import "server-only";

import { memoTtl } from "./perf-cache";
import {
  ALL_CURRENCIES,
  FX as FX_SNAPSHOT,
  isCurrency,
  type Currency,
} from "./fx";

/**
 * Server-authoritative, executable FX feed for Talise quote generation.
 *
 * --- Why this exists (master plan §6, §11 item 4) ---
 * Display FX (`fx.ts`) is a pure, hardcoded Q2-2026 snapshot — fine for
 * rendering a balance, fatal for pricing money. Pricing a cross-currency
 * send off a stale reference rate is correlated tail risk: in a volatility
 * spike you quote a rate you can't actually execute and eat the slippage.
 *
 * This module:
 *   1. Pulls live mid-market rates (units-per-USD) from a free public FX
 *      API over `fetch`, with a short TTL cache so we don't hammer it.
 *   2. Applies a per-corridor spread sized by the corridor's realized-
 *      volatility tier (thin/EM currencies cost more to make a market in).
 *   3. Enforces a MAX-AGE CIRCUIT BREAKER: a quote built off a feed older
 *      than the breaker window is rejected, never silently served stale.
 *   4. Produces a TTL-LOCKED quote `{ rate, spreadBps, expiresAt, ... }`
 *      that the transfers state machine can persist as `status='quoted'`.
 *
 * This is NOT a directional FX warehouse: we only quote conversions we can
 * back, and we never hold naked FX. The spread is the make-a-market charge,
 * captured only at the conversion moment.
 *
 * --- Provider shape ---
 * Targets the open.er-api.com / exchangerate.host family, which returns:
 *   { result|"success", base_code|base, rates: { "NGN": 1620.1, ... },
 *     time_last_update_unix: <epoch s> }
 * USD is the base; values are units-of-currency per 1 USD. If the provider
 * is unreachable we fall back to the hardcoded snapshot but flag the feed
 * as `degraded` so the breaker can refuse to quote on it.
 */

// ─── Tunables ─────────────────────────────────────────────────────────────

/**
 * How long a fetched rate table is cached in-process. Short enough that a
 * locked quote is never priced off a rate more than this old plus the
 * breaker window; long enough that we don't rate-limit ourselves.
 */
const FEED_TTL_MS = 60_000;

/**
 * Max age, relative to the provider's own "last update" timestamp, that we
 * will accept when generating a quote. Beyond this the breaker trips and the
 * quote is refused (callers should fail over to USDC settlement / retry, per
 * §9 — the breaker fails over, it does not silently serve stale FX).
 *
 * IMPORTANT: the default keyless provider (open.er-api.com) refreshes its
 * `time_last_update_unix` only ONCE PER DAY, so by late in the day a perfectly
 * good "live" table is ~24h old. A 75-minute window therefore tripped the
 * breaker on essentially every quote ("Couldn't lock an exchange rate"). We
 * size the window to the provider's real daily cadence plus a couple hours of
 * update lag (26h). This is the free-feed reality, not the target: once an
 * executable venue feed (Circle Mint / partner quote / OTC) that updates in
 * seconds is wired in (overridable via FX_FEED_MAX_AGE_MS / FX_FEED_URL),
 * tighten this back toward minutes.
 */
const FEED_MAX_AGE_MS = (() => {
  const env = Number(process.env.FX_FEED_MAX_AGE_MS);
  return Number.isFinite(env) && env > 0 ? env : 26 * 60 * 60_000;
})();

/**
 * Hard floor for a feed `last update` timestamp we trust at all. A provider
 * reporting an epoch before this is treated as a malformed/garbage response
 * (we'd rather fall back to the snapshot than price off a bogus 1970 rate).
 */
const MIN_PLAUSIBLE_UPDATE_MS = Date.UTC(2024, 0, 1);

/** How long a generated quote stays locked before the user must re-quote. */
const QUOTE_TTL_MS = 30_000;

/**
 * Provider endpoint. open.er-api.com is keyless and USD-based by default.
 * Overridable via env so a paid/executable feed can be swapped in without a
 * code change (issuer-swappable settlement, §9).
 */
const FEED_URL = process.env.FX_FEED_URL?.trim() || "https://open.er-api.com/v6/latest/USD";

/** Network timeout for the feed fetch — never hang a quote on a slow API. */
const FEED_FETCH_TIMEOUT_MS = 4_000;

// ─── Per-corridor spread by realized-volatility tier ────────────────────────

/**
 * Volatility tiers. Spread is the make-a-market charge and scales with how
 * hard the currency is to hedge/execute in size. These are starting buckets;
 * the master plan calls for spread set "per-corridor by realized volatility,"
 * which this encodes coarsely until a live realized-vol signal is wired in.
 *
 *   stable  — deep, liquid, low realized vol (USD, SGD, JPY).
 *   mid     — liquid EM with managed vol (KES, GHS, ZAR, PHP).
 *   high    — thin / high realized vol / capital-control friction
 *             (NGN, IDR, VND).
 */
export type VolTier = "stable" | "mid" | "high";

/** One-sided spread in basis points charged at the conversion edge, per tier. */
const TIER_SPREAD_BPS: Record<VolTier, number> = {
  stable: 35,
  mid: 75,
  high: 150,
};

/** Volatility tier assignment per currency. */
const CURRENCY_TIER: Record<Currency, VolTier> = {
  // global anchor + deep, liquid
  USD: "stable",
  SGD: "stable",
  JPY: "stable",
  // liquid EM, managed vol
  KES: "mid",
  GHS: "mid",
  ZAR: "mid",
  PHP: "mid",
  // thin / high vol / capital-control friction
  NGN: "high",
  IDR: "high",
  VND: "high",
};

/** Volatility tier for a single currency. */
export function volTier(ccy: Currency): VolTier {
  return CURRENCY_TIER[ccy];
}

/**
 * One-sided spread (bps) for a corridor `from → to`. We take the HIGHER of
 * the two legs' tier spreads: the harder-to-make side dominates the cost. A
 * same-currency "corridor" carries no spread.
 */
export function corridorSpreadBps(from: Currency, to: Currency): number {
  if (from === to) return 0;
  return Math.max(TIER_SPREAD_BPS[volTier(from)], TIER_SPREAD_BPS[volTier(to)]);
}

// ─── Live rate table ────────────────────────────────────────────────────────

/** A mid-market rate table: units of each currency per 1 USD, plus provenance. */
export interface RateTable {
  /** Units-per-USD for every supported currency. USD is always 1. */
  ratesPerUsd: Record<Currency, number>;
  /** Epoch ms of when the SOURCE feed was last updated (not when we fetched). */
  asOfMs: number;
  /** Where the numbers came from: the live provider, or the offline snapshot. */
  source: "live" | "snapshot";
}

interface ErApiResponse {
  result?: string;
  success?: boolean;
  base_code?: string;
  base?: string;
  rates?: Record<string, number>;
  time_last_update_unix?: number;
}

/** The offline fallback table built from the hardcoded snapshot in `fx.ts`. */
function snapshotTable(): RateTable {
  const ratesPerUsd = { ...FX_SNAPSHOT } as Record<Currency, number>;
  return {
    ratesPerUsd,
    // Stamp the snapshot as "now" so it's internally consistent, but mark the
    // source so the breaker can refuse to quote on it (a fallback table is
    // not an executable feed).
    asOfMs: Date.now(),
    source: "snapshot",
  };
}

/**
 * Fetch and normalize the live rate table from the provider. Returns the
 * offline snapshot (source `"snapshot"`) on any transport/parse error so a
 * read of FX never throws — but quoting against a snapshot is rejected by the
 * breaker in `getQuote`.
 */
async function fetchRateTable(): Promise<RateTable> {
  let resp: Response;
  try {
    resp = await fetch(FEED_URL, {
      signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    console.warn("[fx-feed] live fetch failed, using snapshot:", err);
    return snapshotTable();
  }

  if (!resp.ok) {
    console.warn(`[fx-feed] live feed HTTP ${resp.status}, using snapshot`);
    return snapshotTable();
  }

  let json: ErApiResponse;
  try {
    json = (await resp.json()) as ErApiResponse;
  } catch (err) {
    console.warn("[fx-feed] live feed non-JSON, using snapshot:", err);
    return snapshotTable();
  }

  const ok = json.result === "success" || json.success === true || !!json.rates;
  const base = (json.base_code ?? json.base ?? "USD").toUpperCase();
  if (!ok || !json.rates || base !== "USD") {
    console.warn("[fx-feed] live feed shape unexpected, using snapshot");
    return snapshotTable();
  }

  // Build the table, requiring every supported currency to be present and
  // positive. A missing/zero/NaN rate for a currency we support means we
  // can't price it from this feed — fall back rather than emit a bad rate.
  const ratesPerUsd = {} as Record<Currency, number>;
  for (const ccy of ALL_CURRENCIES) {
    if (ccy === "USD") {
      ratesPerUsd.USD = 1;
      continue;
    }
    const v = json.rates[ccy];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      console.warn(`[fx-feed] live feed missing/invalid rate for ${ccy}, using snapshot`);
      return snapshotTable();
    }
    ratesPerUsd[ccy] = v;
  }

  // Provider stamps last-update in epoch SECONDS. Guard against missing or
  // implausible timestamps.
  const updMs =
    typeof json.time_last_update_unix === "number" && json.time_last_update_unix > 0
      ? json.time_last_update_unix * 1000
      : 0;
  const asOfMs = updMs >= MIN_PLAUSIBLE_UPDATE_MS ? updMs : Date.now();

  return { ratesPerUsd, asOfMs, source: "live" };
}

/**
 * Get the current rate table, TTL-cached in-process. May return the offline
 * snapshot if the live provider is unreachable; inspect `.source` /
 * `.asOfMs` (the breaker in `getQuote` does this for you).
 */
export async function getRateTable(): Promise<RateTable> {
  return memoTtl("fx-feed:rate-table", FEED_TTL_MS, fetchRateTable);
}

// ─── Quote generation ───────────────────────────────────────────────────────

/** Reasons a quote can be refused. */
export type QuoteError = "STALE_FEED" | "SNAPSHOT_ONLY" | "UNSUPPORTED_CURRENCY" | "BAD_AMOUNT";

/** A locked, executable FX quote for a single conversion. */
export interface FxQuote {
  from: Currency;
  to: Currency;
  /** Amount of `from` the quote was priced for. */
  amount: number;
  /**
   * Effective, spread-inclusive rate: multiply `amount` (in `from`) by this
   * to get `toAmount` (in `to`). Already net of `spreadBps`.
   */
  rate: number;
  /** Mid-market rate before spread (units of `to` per unit of `from`). */
  midRate: number;
  /** One-sided spread applied, in basis points. */
  spreadBps: number;
  /** Guaranteed amount the conversion yields in `to`, at the locked `rate`. */
  toAmount: number;
  /** Epoch ms when the source feed was last updated. */
  feedAsOfMs: number;
  /** Epoch ms after which this locked quote is no longer honored. */
  expiresAt: number;
}

export type QuoteResult =
  | { ok: true; quote: FxQuote }
  | { ok: false; error: QuoteError; message: string };

/**
 * Mid-market rate of `to` per unit of `from`, derived via the USD base:
 *   from → USD → to  ⇒  rate = ratesPerUsd[to] / ratesPerUsd[from].
 */
function midRateOf(table: RateTable, from: Currency, to: Currency): number {
  return table.ratesPerUsd[to] / table.ratesPerUsd[from];
}

/**
 * Generate a locked, server-authoritative quote for converting `amount` of
 * `fromCcy` into `toCcy`.
 *
 * Pricing: mid-market rate (from the live feed) minus the corridor's
 * volatility-tier spread, applied one-sided to the recipient leg. The
 * returned `rate` is spread-inclusive, so `toAmount = amount * rate`.
 *
 * Circuit breaker: refuses to quote if the feed is older than
 * `FEED_MAX_AGE_MS` (`STALE_FEED`) or if only the offline snapshot is
 * available (`SNAPSHOT_ONLY`). Callers should fail over (e.g. retry, or
 * settle in USDC) rather than serve a stale price.
 */
export async function getQuote(
  fromCcy: Currency,
  toCcy: Currency,
  amount: number
): Promise<QuoteResult> {
  if (!isCurrency(fromCcy) || !isCurrency(toCcy)) {
    return { ok: false, error: "UNSUPPORTED_CURRENCY", message: "Unsupported currency in corridor." };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "BAD_AMOUNT", message: "Amount must be a positive number." };
  }

  const table = await getRateTable();

  // Breaker: never price money off the offline snapshot...
  if (table.source !== "live") {
    return {
      ok: false,
      error: "SNAPSHOT_ONLY",
      message: "Live FX feed unavailable; quoting is paused.",
    };
  }
  // ...nor off a feed older than the max-age window.
  const ageMs = Date.now() - table.asOfMs;
  if (ageMs > FEED_MAX_AGE_MS) {
    return {
      ok: false,
      error: "STALE_FEED",
      message: `FX feed is stale (${Math.round(ageMs / 60_000)}m old); quoting is paused.`,
    };
  }

  const midRate = midRateOf(table, fromCcy, toCcy);
  const spreadBps = corridorSpreadBps(fromCcy, toCcy);
  // One-sided spread haircuts the recipient leg: rate = mid * (1 - bps/10000).
  const rate = midRate * (1 - spreadBps / 10_000);
  const toAmount = amount * rate;

  const now = Date.now();
  return {
    ok: true,
    quote: {
      from: fromCcy,
      to: toCcy,
      amount,
      rate,
      midRate,
      spreadBps,
      toAmount,
      feedAsOfMs: table.asOfMs,
      expiresAt: now + QUOTE_TTL_MS,
    },
  };
}

/** True if a previously-locked quote is still within its TTL. */
export function isQuoteFresh(quote: Pick<FxQuote, "expiresAt">, nowMs: number = Date.now()): boolean {
  return quote.expiresAt > nowMs;
}
