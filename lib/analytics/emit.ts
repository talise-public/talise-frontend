import "server-only";

import { after } from "next/server";

import { db } from "@/lib/db";
import { amountBand, type GrowthPlatform } from "@/lib/analytics/events";
import { emitGrowthEvent } from "@/lib/analytics/growth-ingest";
import {
  FEE_SCHEDULE,
  recordRevenue,
  type RecordRevenueInput,
} from "@/lib/analytics/growth-revenue";

/**
 * THE SERVER-SIDE EMIT SURFACE.
 *
 * `growth-ingest.ts` gave us `emitGrowthEvent()` and `growth-revenue.ts` gave us
 * `recordRevenue()`. Neither had a single call site, so twelve event names — every
 * money event — were never written by anything, and `revenue_events` was
 * permanently empty. This module is the layer that connects them to the routes
 * where the truth actually lives.
 *
 * It exists as a layer rather than as bare calls in each route for three reasons:
 *
 *  1. ONE PLACE FOR THE PRIVACY RULES. Every helper here bands its amount
 *     (`amountBand`), and none of them can be handed an address, a digest, a
 *     handle, an email or an IP — the parameter types don't allow it. A route
 *     author cannot accidentally leak a digest into `growth_events` because
 *     there is no parameter to put one in. (Digests appear only as
 *     `revenue_events.ref`, which is that table's documented idempotency key,
 *     not a behavioural record.)
 *
 *  2. ONE PLACE FOR THE NON-BLOCKING CONTRACT. `emitGrowthEvent()` is already
 *     sync + self-guarded + `after()`-scheduled. `recordRevenue()` is an async
 *     function that awaits Postgres, so calling it bare from a money path would
 *     either be awaited (adding latency to a send) or floated (and killed when
 *     the serverless response returns). `revenueAfter()` below schedules it with
 *     `after()` so it runs POST-RESPONSE, exactly like the ingest path.
 *
 *  3. ONE PLACE FOR "MEASURED VS DERIVED". Each helper states in its signature
 *     whether the fee it records was observed by the server or computed from
 *     `FEE_SCHEDULE`, and passes `derived` through to the ledger, so a dashboard
 *     can report the two separately instead of blending them.
 *
 * ── The hard contract every helper here honours ─────────────────────────────
 *
 *   • Returns `void`, synchronously. A caller can never await it, so it can
 *     never add latency to the request it is measuring.
 *   • Never throws. Every body is wrapped, and the scheduled work is wrapped
 *     again inside `detach()`.
 *   • Runs after the response. Nothing here holds a Postgres connection while a
 *     user is waiting, which matters because the prod pool is `max: 8` and
 *     shared with the money paths.
 *
 * So the rule for a money route is: call it on the line AFTER the money is
 * confirmed, ignore the return value, and change nothing else.
 */

// ── Scheduling ───────────────────────────────────────────────────────────────

/**
 * Run `fn` after the response, swallowing everything.
 *
 * Mirrors `runInBackground` in growth-ingest.ts (and `refreshInBackground` in
 * lib/snapshots.ts): `after()` on Vercel, a detached promise anywhere else. The
 * double guard is deliberate — `after()` itself throws when called outside a
 * request scope, and the work can reject.
 */
function detach(fn: () => Promise<unknown>): void {
  const guarded = () =>
    Promise.resolve()
      .then(fn)
      .catch((e) => console.warn(`[growth-emit] ${(e as Error)?.message ?? e}`));
  try {
    after(guarded);
  } catch {
    void guarded();
  }
}

/**
 * Append a fee to `revenue_events` after the response.
 *
 * `recordRevenue()` is already idempotent on (source, ref) and already swallows
 * its own errors; this only adds the post-response scheduling that makes it safe
 * to call from a route that just moved money.
 */
export function revenueAfter(input: RecordRevenueInput): void {
  try {
    detach(() => recordRevenue(input));
  } catch {
    /* revenue accounting must never surface an error to a caller */
  }
}

/** Clamp a client-asserted USD figure to the same ceiling the rewards engine uses. */
const MAX_ASSERTED_USD = 10_000;

function assertedUsd(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, MAX_ASSERTED_USD);
}

// ── Onboarding / lifecycle ───────────────────────────────────────────────────

/**
 * The user now owns a `*.talise.sui` handle.
 *
 * Stamps `growth_user_firsts.handle_claimed_at`, which was structurally always
 * NULL: no call site emitted `handle_claimed`, so "how many signups ever get a
 * handle, and how long does it take them" had no answer.
 */
export function trackHandleClaimed(userId: number, surface = "username.claim"): void {
  emitGrowthEvent("handle_claimed", { userId, surface, status: "ok" });
}

/** A verification attempt was opened (tier upgrade intent / hosted KYC link). */
export function trackKycStarted(
  userId: number,
  opts: { surface?: string; tier?: number } = {}
): void {
  emitGrowthEvent("kyc_started", {
    userId,
    surface: opts.surface ?? "kyc",
    status: "started",
    props: opts.tier != null ? { tier: opts.tier } : undefined,
  });
}

/**
 * Verification cleared. Stamps `growth_user_firsts.kyc_completed_at` — also
 * structurally always NULL before this.
 *
 * Only ever called from a provider-verified verdict (the signed eKYC webhook, or
 * a Bridge status read), never from a client claim.
 */
export function trackKycCompleted(
  userId: number,
  opts: { surface?: string; tier?: number } = {}
): void {
  emitGrowthEvent("kyc_completed", {
    userId,
    surface: opts.surface ?? "kyc",
    status: "ok",
    props: opts.tier != null ? { tier: opts.tier } : undefined,
  });
}

/**
 * A push token was registered for this user, which is server-side PROOF the OS
 * permission prompt was granted — stronger evidence than the client event, and
 * it stamps `push_enabled_at` (the fourth structurally-NULL column).
 */
export function trackPushEnabled(userId: number, platform: GrowthPlatform): void {
  emitGrowthEvent("push_permission_granted", {
    userId,
    platform,
    surface: "devices.register",
    status: "ok",
  });
}

// ── Money in ─────────────────────────────────────────────────────────────────

/** A funding session was opened (virtual account / hosted widget handed back). */
export function trackDepositStarted(
  userId: number,
  opts: { usd?: number | null; provider?: string; currency?: string } = {}
): void {
  emitGrowthEvent("deposit_started", {
    userId,
    surface: "onramp.session",
    status: "started",
    amountBand: amountBand(opts.usd ?? null),
    currency: opts.currency,
    props: opts.provider ? { provider: opts.provider } : undefined,
  });
}

/**
 * Money landed in the user's wallet, observed server-side.
 *
 * Emits BOTH `deposit_completed` and `funded`. `funded` is the activation
 * milestone and is exactly-once per user by construction — `upsertFirsts` writes
 * `funded_at` as LEAST(COALESCE(existing, new), new), so the earliest wins
 * forever and a replay is a no-op. That is why this helper does not need to know
 * whether it is the user's first deposit.
 *
 * Only ONE route can honestly call this (a cheque claim releasing escrow to the
 * claimer). The card/bank on-ramps mint straight to the user's own Sui address
 * with no server-side credit, so their funding is picked up by the ledger
 * derivation in growth-ingest.ts instead.
 */
export function trackFunded(
  userId: number,
  opts: { usd?: number | null; source?: string; currency?: string; at?: number } = {}
): void {
  const band = amountBand(opts.usd ?? null);
  const props = opts.source ? { source: opts.source } : undefined;
  emitGrowthEvent("deposit_completed", {
    userId,
    surface: "deposit",
    status: "ok",
    amountBand: band,
    currency: opts.currency,
    props,
  });
  emitGrowthEvent("funded", {
    userId,
    surface: "deposit",
    status: "ok",
    amountBand: band,
    currency: opts.currency,
    props,
  });
}

// ── Money out ────────────────────────────────────────────────────────────────

/**
 * A send landed on chain.
 *
 * Emits `send_completed` only, NOT `first_send`: `send_completed` is now mapped
 * to `first_send_at` in `FIRST_COLUMNS`, so the FIRST one stamps the activation
 * milestone and the rest are no-ops on that column. Emitting a literal
 * `first_send` row per send would put N "first" sends in the event log for one
 * user, which is exactly the kind of rot the taxonomy's one-name-per-action rule
 * exists to prevent.
 */
export function trackSendCompleted(
  userId: number,
  opts: {
    usd?: number | null;
    surface?: string;
    corridor?: string;
    currency?: string;
    platform?: GrowthPlatform;
  } = {}
): void {
  emitGrowthEvent("send_completed", {
    userId,
    surface: opts.surface ?? "send",
    status: "ok",
    amountBand: amountBand(opts.usd ?? null),
    currency: opts.currency,
    corridor: opts.corridor,
    platform: opts.platform,
  });
}

/** A cash-out order was created (fiat payout requested). */
export function trackCashoutStarted(
  userId: number,
  opts: { usd?: number | null; corridor?: string; provider?: string } = {}
): void {
  emitGrowthEvent("cashout_started", {
    userId,
    surface: "cashout",
    status: "started",
    amountBand: amountBand(opts.usd ?? null),
    corridor: opts.corridor,
    props: opts.provider ? { provider: opts.provider } : undefined,
  });
}

// ── Revenue-bearing actions ──────────────────────────────────────────────────

/**
 * A swap settled.
 *
 * NO revenue row: Talise's 1% swap fee is taken NATIVELY by the Cetus overlay
 * inside the PTB, so the server never observes the charged amount after
 * confirmation, and the fee is 0 bps for a stablecoin source. Deriving 1% from
 * an asserted output would silently over-count every fee-free USDC→USDsui swap.
 * The event is recorded; the fee deliberately is not. See METRICS.md.
 */
export function trackSwapCompleted(
  userId: number,
  opts: { usd?: number | null; platform?: GrowthPlatform } = {}
): void {
  emitGrowthEvent("swap_completed", {
    userId,
    surface: "swap",
    status: "ok",
    amountBand: amountBand(opts.usd ?? null),
    platform: opts.platform,
  });
}

/**
 * USDsui was supplied to a yield venue, and (for the venues that charge it) the
 * 1% treasury fee leg rode along in the same PTB.
 *
 * The fee is DERIVED: `FEE_SCHEDULE.earnSupplyBps` × the principal, where the
 * principal is the client's asserted amount clamped to $10k (the same ceiling
 * the rewards engine applies to the same field). The PTB the server built took
 * exactly `principal × 1%`, so the schedule is right; what is asserted is the
 * principal, which is why the row is marked `derived: true`.
 *
 * DeepBook margin supply takes no treasury fee, so no revenue is recorded for it.
 */
const FEE_CHARGING_EARN_VENUES: ReadonlySet<string> = new Set(["navi", "scallop"]);

export function trackEarnSupplied(
  userId: number,
  opts: {
    usd?: number | null;
    venue?: string | null;
    /** On-chain digest, used as the ledger's idempotency key. */
    ref?: string | null;
    platform?: GrowthPlatform;
  } = {}
): void {
  const usd = assertedUsd(opts.usd);
  const venue = (opts.venue ?? "").toLowerCase();
  emitGrowthEvent("earn_supplied", {
    userId,
    surface: "earn.supply",
    status: "ok",
    amountBand: amountBand(usd),
    feeUsd:
      usd != null && FEE_CHARGING_EARN_VENUES.has(venue)
        ? (usd * FEE_SCHEDULE.earnSupplyBps) / 10_000
        : undefined,
    props: venue ? { venue } : undefined,
    platform: opts.platform,
  });

  if (usd == null || !opts.ref || !FEE_CHARGING_EARN_VENUES.has(venue)) return;
  revenueAfter({
    source: "earn_supply",
    ref: opts.ref,
    userId,
    grossUsd: usd,
    feeUsd: (usd * FEE_SCHEDULE.earnSupplyBps) / 10_000,
    feeBps: FEE_SCHEDULE.earnSupplyBps,
    currency: "USD",
    platform: opts.platform ?? "server",
    derived: true,
  });
}

/**
 * A perp position was closed at market.
 *
 * The only MEASURED fee in the ledger. `feeUsd` is computed by `buildCloseTx`
 * from the position's ON-CHAIN collateral and appended to that very PTB as a
 * USDsui transfer to the treasury; it is > 0 only when the fee leg is actually
 * in the transaction. Nothing about it comes from the client, so the row is
 * recorded with `derived: false`.
 */
export function trackPerpClosed(
  userId: number,
  opts: { feeUsd: number; ref: string; ticker?: string; platform?: GrowthPlatform }
): void {
  const fee = Number(opts.feeUsd);
  const ok = Number.isFinite(fee) && fee > 0;
  emitGrowthEvent("perp_closed", {
    userId,
    surface: "perps.close",
    status: "ok",
    feeUsd: ok ? fee : undefined,
    props: opts.ticker ? { ticker: opts.ticker } : undefined,
    platform: opts.platform,
  });
  if (!ok || !opts.ref) return;
  revenueAfter({
    source: "perp_close",
    ref: opts.ref,
    userId,
    feeUsd: fee,
    feeBps: FEE_SCHEDULE.perpCloseBps,
    currency: "USD",
    platform: opts.platform ?? "server",
    derived: false,
  });
}

// ── Off-ramp settlement (provider webhooks) ──────────────────────────────────

/**
 * Terminal cash-out outcome, driven by a provider webhook.
 *
 * A webhook authenticates an ORDER, not a user: it carries the provider's own
 * reference and nothing else. So the user has to be resolved from the attempt
 * ledger before an event can be attributed. That lookup is one indexed row
 * (`offramp_attempts` is UNIQUE on (provider, provider_ref)) with a
 * `linq_offramps` fallback for orders created before the cross-rail ledger
 * existed — and it runs entirely inside `detach()`, i.e. AFTER the webhook has
 * already been acknowledged. The provider's retry behaviour, and the payout
 * state machine, are untouched by it.
 *
 * `cashout_completed` stamps `growth_user_firsts.first_cashout_at` (the third
 * structurally-NULL column).
 */
export function trackCashoutSettled(opts: {
  provider: string;
  providerRef: string;
  ok: boolean;
  errorCode?: string;
}): void {
  const { provider, providerRef, ok } = opts;
  if (!providerRef) return;
  detach(async () => {
    const found = await lookupOfframpAttempt(provider, providerRef);
    if (!found || found.userId == null) return;
    emitGrowthEvent(ok ? "cashout_completed" : "cashout_failed", {
      userId: found.userId,
      surface: "cashout",
      status: ok ? "ok" : "error",
      errorCode: ok ? undefined : opts.errorCode,
      amountBand: amountBand(found.usd),
      corridor: found.corridor ?? undefined,
      props: { provider },
    });
  });
}

type OfframpAttemptRow = {
  userId: number | null;
  usd: number | null;
  corridor: string | null;
};

/**
 * Resolve (provider, providerRef) → user + banded-able amount + corridor.
 *
 * `user_id` is TEXT on both tables while `users.id` is INTEGER, so it is parsed
 * rather than assumed. Returns null on anything unexpected; a webhook must never
 * be affected by an analytics lookup.
 */
async function lookupOfframpAttempt(
  provider: string,
  providerRef: string
): Promise<OfframpAttemptRow | null> {
  const c = db();
  try {
    const r = await c.execute({
      sql: `SELECT user_id, usd_amount, corridor
              FROM offramp_attempts
             WHERE provider = ? AND provider_ref = ?
             LIMIT 1`,
      args: [provider, providerRef],
    });
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (row) {
      return {
        userId: intOrNull(row.user_id),
        usd: numOrNull(row.usd_amount),
        corridor: row.corridor == null ? null : String(row.corridor),
      };
    }
  } catch {
    /* fall through to the legacy table */
  }
  if (provider !== "linq") return null;
  try {
    const r = await c.execute({
      sql: `SELECT user_id, amount_usdsui
              FROM linq_offramps
             WHERE linq_order_id = ?
             LIMIT 1`,
      args: [providerRef],
    });
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      userId: intOrNull(row.user_id),
      usd: numOrNull(row.amount_usdsui),
      corridor: "NGN",
    };
  } catch {
    return null;
  }
}

function intOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Confirmed-execution fan-out ──────────────────────────────────────────────

/**
 * The one call the two sponsored/gasless execution rails make once a digest is
 * confirmed and NOT aborted.
 *
 * Both rails already receive a `meta` hint from the client naming what the PTB
 * they just broadcast was for (`send` / `invest` / `withdraw` / `roundup` /
 * `goal` / `swap`), validated there against a closed enum before the rewards
 * engine trusts it. This maps that same already-validated hint onto the event
 * taxonomy so one call site covers every money action that rides the rail.
 *
 * `kind` is treated as a HINT, never as authority:
 *   • the user id comes from the session, never from the body;
 *   • the amount is banded, so the worst a lying client achieves is putting its
 *     own action in the wrong coarse bucket;
 *   • the only fee it can influence is the derived earn-supply row, which is
 *     clamped and explicitly marked derived.
 *
 * Unmapped kinds (`withdraw`, `roundup`, `goal`, `consolidate`, `retarget`) are
 * deliberately dropped: the closed taxonomy has no event for them, and inventing
 * names is what the taxonomy's own design rules forbid.
 */
export function trackConfirmedExecution(opts: {
  userId: number;
  digest: string;
  kind: unknown;
  amountUsd: unknown;
  venue?: unknown;
  surface?: string;
  platform?: GrowthPlatform;
}): void {
  try {
    const kind = typeof opts.kind === "string" ? opts.kind : "";
    const usd = assertedUsd(opts.amountUsd);
    const venue = typeof opts.venue === "string" ? opts.venue : null;
    switch (kind) {
      case "send":
        trackSendCompleted(opts.userId, {
          usd,
          surface: opts.surface ?? "send",
          platform: opts.platform,
        });
        return;
      case "invest":
        trackEarnSupplied(opts.userId, {
          usd,
          venue,
          ref: opts.digest || null,
          platform: opts.platform,
        });
        return;
      case "swap":
        trackSwapCompleted(opts.userId, { usd, platform: opts.platform });
        return;
      default:
        return;
    }
  } catch {
    /* analytics must never surface an error to a money path */
  }
}
