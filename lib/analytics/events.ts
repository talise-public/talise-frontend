/**
 * THE TALISE GROWTH EVENT TAXONOMY.
 *
 * This module is ISOMORPHIC on purpose — it has no `server-only`, no node
 * imports and no DB access, so the browser emitter
 * (web/lib/analytics/growth-browser.ts), the ingest route
 * (web/app/api/events/route.ts) and any server call site all typecheck against
 * exactly the same names. iOS (`ios/Talise/Network/GrowthAnalytics.swift`) and
 * Android (`android/.../core/analytics/Growth.kt`) mirror these strings
 * verbatim.
 *
 * Design rules for this taxonomy:
 *
 *  1. ONE name per real-world action, `object_verb_past_tense`. No free-form
 *     event names — the union below is closed, and the ingest route drops
 *     anything not in it. An open event namespace is how analytics tables rot.
 *  2. Dimensions are COLUMNS, not names. There is no `send_completed_ios`;
 *     there is `send_completed` with `platform:"ios"`.
 *  3. Every event exists to unlock a metric that is unmeasurable today. If you
 *     can't name the metric, don't add the event. The metric each one unlocks
 *     is documented inline.
 *  4. Money amounts are BANDED, never exact (see `amountBand`). Fees are exact
 *     because a fee is Talise's revenue, not the user's balance.
 */

// ── Platforms ────────────────────────────────────────────────────────────────

/** `server` is for events derived server-side (e.g. signup_completed). */
export const GROWTH_PLATFORMS = ["web", "ios", "android", "server"] as const;
export type GrowthPlatform = (typeof GROWTH_PLATFORMS)[number];

// ── The taxonomy ─────────────────────────────────────────────────────────────

/**
 * Every event, grouped by the metric family it serves. The comment on each
 * line names the previously-unmeasurable metric it unlocks.
 */
export const GROWTH_EVENTS = [
  // ── Lifecycle / retention ──────────────────────────────────────────────
  // THE keystone event. Before this there was no app-open signal at all
  // (`users.last_seen_at` moves only on sign-in / token refresh), so DAU,
  // WAU, MAU and real D1/D7/D30 retention were all impossible.
  "app_open",
  // First open on a fresh install/browser → installs, and the
  // install→signup conversion rate.
  "app_first_open",
  // Coarse screen name. Unlocks per-screen drop-off on iOS/Android, which
  // were total black boxes. Emitted for flow screens only, not every view.
  "screen_view",

  // ── Signup funnel ──────────────────────────────────────────────────────
  // Tap on "Continue with Google/Apple" → top of the signup funnel, so
  // auth abandonment becomes visible.
  "signup_started",
  // OAuth + zkLogin exchange returned a session → separates "user gave up in
  // Google's sheet" from "our exchange failed".
  "signup_auth_completed",
  // Server-DERIVED (never trusted from a client): the account row is new.
  // Anchors every cohort and is the denominator of activation + retention.
  "signup_completed",
  // Per-step onboarding progress (`step` = splash|welcome|intro|signIn|
  // handlePicker|country|pinSetup|permissions|done) → step-level drop-off.
  "onboarding_step",
  "onboarding_completed",
  "handle_claimed",
  "kyc_started",
  "kyc_completed",

  // ── Activation: money in ───────────────────────────────────────────────
  "deposit_started",
  "deposit_failed",
  // FIRST money in, exactly-once per user (enforced by growth_user_firsts).
  // Unlocks activation rate and time-to-funded.
  "funded",
  "deposit_completed",

  // ── Activation: money out ──────────────────────────────────────────────
  "send_started",
  "send_reviewed",
  "send_completed",
  "send_failed",
  // FIRST send, exactly-once per user → the real activation milestone and
  // time-to-first-send from a client's point of view.
  "first_send",
  "cashout_started",
  "cashout_completed",
  "cashout_failed",

  // ── Revenue-bearing actions (carry `fee_usd`) ──────────────────────────
  "swap_completed",
  "earn_supplied",
  "perp_closed",

  // ── Virality / K-factor ────────────────────────────────────────────────
  // The share sheet actually completed → invites SENT (the K denominator).
  "invite_sent",
  // A `?ref=`/`?i=` landing → invite click-through rate.
  "invite_clicked",
  // Server-DERIVED: a signup attributable to an invite (the K numerator).
  "invite_signup",

  // ── Acquisition attribution ────────────────────────────────────────────
  // First touch on a browser/device, carries utm/referrer. Unlocks
  // acquisition attribution, which had no storage at all before.
  "first_touch",

  // ── Push / notification performance ────────────────────────────────────
  "push_permission_granted",
  "push_permission_denied",
  // Opened the app FROM a push → push CTR, previously unmeasurable.
  "notification_opened",
] as const;

export type GrowthEventName = (typeof GROWTH_EVENTS)[number];

const EVENT_SET: ReadonlySet<string> = new Set(GROWTH_EVENTS);

export function isGrowthEvent(name: unknown): name is GrowthEventName {
  return typeof name === "string" && EVENT_SET.has(name);
}

/**
 * Events a CLIENT may never assert — they are derived server-side from data
 * the server can verify. A client POSTing one of these is silently dropped, so
 * a tampered client can't inflate the signup or K-factor numbers.
 */
export const SERVER_DERIVED_EVENTS: ReadonlySet<GrowthEventName> = new Set([
  "signup_completed",
  "invite_signup",
]);

/**
 * Events that mark a set-once user milestone, and the `growth_user_firsts`
 * column each one stamps. The ingest path writes these with
 * COALESCE(existing, new), so the first occurrence wins forever and any
 * client replay is a no-op.
 *
 * Note that TWO events may stamp the SAME column, and that is the mechanism
 * that keeps the event log honest. A money path knows it just completed a send;
 * it does NOT know (without a query) whether that was the user's first. So
 * `send_completed` and `deposit_completed` are mapped onto the milestone columns
 * alongside their explicit `first_send` / `funded` counterparts: the LEAST +
 * COALESCE write means the EARLIEST occurrence wins the column and every later
 * one is a no-op, so the milestone is exact without the emitter needing to know,
 * and without writing N rows named "first_send" for one user.
 */
export const FIRST_COLUMNS: Partial<Record<GrowthEventName, string>> = {
  signup_started: "signup_started_at",
  signup_completed: "signup_completed_at",
  onboarding_completed: "onboarding_completed_at",
  handle_claimed: "handle_claimed_at",
  kyc_completed: "kyc_completed_at",
  funded: "funded_at",
  deposit_completed: "funded_at",
  first_send: "first_send_at",
  send_completed: "first_send_at",
  cashout_completed: "first_cashout_at",
  invite_sent: "first_invite_sent_at",
  push_permission_granted: "push_enabled_at",
};

// ── Shapes ───────────────────────────────────────────────────────────────────

/** Coarse funnel status. Kept tiny so it stays groupable. */
export type GrowthStatus = "started" | "ok" | "error" | "cancelled";

/**
 * What a client POSTs. Everything except `event` is optional; the server fills
 * `user_id`, `country`, `received_at` and `day` itself and will NOT accept
 * them from the wire.
 */
export type GrowthEventInput = {
  event: GrowthEventName;
  /** Epoch ms when it happened on the client. Clamped server-side. */
  ts?: number;
  /** Random client-generated id. NOT a device id, NOT a fingerprint. */
  anonId?: string;
  /** One app/browser session. Rotates after 30 idle minutes. */
  sessionId?: string;
  platform?: GrowthPlatform;
  appVersion?: string;
  /** Coarse screen/route name, e.g. "send.review". Never a full URL. */
  surface?: string;
  /** Funnel step within a flow, e.g. "handlePicker". */
  step?: string;
  status?: GrowthStatus;
  /** Short machine code, e.g. "ACCUMULATOR_UNDERFUNDED". Never a message. */
  errorCode?: string;
  /** Bucketed amount from `amountBand()`. Exact amounts are rejected. */
  amountBand?: string;
  currency?: string;
  /** e.g. "US->NG". */
  corridor?: string;
  /** Talise's fee on this action, in USD. This is revenue, so it is exact. */
  feeUsd?: number;
  /** Opaque invite id minted by the sharing client. */
  inviteId?: string;
  /** Acquisition, first-touch only (see growth-attribution.ts). */
  attribution?: GrowthAttributionInput;
  /** Small whitelisted extras. Values are coerced to string/number/boolean. */
  props?: Record<string, unknown>;
};

/** First-touch acquisition payload. Carried on `first_touch` / `invite_clicked`. */
export type GrowthAttributionInput = {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
  /** HOST ONLY (e.g. "twitter.com"). Full referrer URLs are rejected. */
  referrerHost?: string;
  /** Whitelisted path only (e.g. "/"), never a query string. */
  landingPath?: string;
  /** Raw referral code — hashed on arrival, the plaintext is never stored. */
  refCode?: string;
  inviteId?: string;
};

/** The batch envelope a client POSTs to /api/events. */
export type GrowthBatch = {
  anonId?: string;
  sessionId?: string;
  platform?: GrowthPlatform;
  appVersion?: string;
  events: GrowthEventInput[];
};

// ── Limits (shared by client + server so a client never builds a rejected batch) ──

export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_STRING_LEN = 96;
export const MAX_PROP_KEYS = 8;

// ── Amount banding ───────────────────────────────────────────────────────────

/**
 * Bucket a USD amount into a coarse band.
 *
 * This is the privacy line for the analytics store: knowing that a send was
 * "100-499" is enough for every funnel and cohort question we have, and it is
 * NOT a record of what a named person moved. Exact amounts stay in the money
 * tables (`transfers`, `tx_history`), which are access-controlled.
 *
 * Bands are open-ended at the top so a whale's exact size never leaks.
 */
export function amountBand(usd: number | null | undefined): string | undefined {
  if (usd == null || !Number.isFinite(usd)) return undefined;
  const v = Math.abs(usd);
  if (v === 0) return "0";
  if (v < 1) return "<1";
  if (v < 5) return "1-4";
  if (v < 20) return "5-19";
  if (v < 50) return "20-49";
  if (v < 100) return "50-99";
  if (v < 500) return "100-499";
  if (v < 1_000) return "500-999";
  if (v < 5_000) return "1k-5k";
  return "5k+";
}

/** The bands `amountBand` can return, for a dashboard's ORDER BY. */
export const AMOUNT_BANDS = [
  "0",
  "<1",
  "1-4",
  "5-19",
  "20-49",
  "50-99",
  "100-499",
  "500-999",
  "1k-5k",
  "5k+",
] as const;
