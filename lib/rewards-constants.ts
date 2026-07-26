/**
 * Talise rewards policy, pure constants + presentation helpers.
 *
 * No DB, no fetch, no `server-only` directive. Safe to import from client
 * components (RewardsPanel, OnboardingFlow). The server-side helpers live
 * in `lib/rewards/*` (earn / referral / integrity / verify) which DO carry
 * the `server-only` pragma because they talk to Postgres and the chain.
 *
 * ── Read this before changing a number ──────────────────────────────
 *
 * Points are a liability. The moment a SKU exists in
 * `lib/rewards/catalogue.ts` (currently intentionally EMPTY, see the
 * comment there) every point is a claim on real value, so the numbers
 * below are an issuance budget and not decoration. The rules that keep
 * them honest:
 *
 *   1. Nothing here may be paid on a CLIENT-ASSERTED amount. Money awards
 *      are paid on a chain-verified amount only (lib/rewards/verify.ts).
 *   2. Nothing may be paid for an action that is free to repeat. Signing
 *      up is free (zkLogin over Google), so signup pays ZERO.
 *   3. Every payout is idempotent and reversible (lib/rewards/integrity.ts).
 */

import type { RewardsEventKind } from "./db";

export const POINTS = {
  /**
   * Inviter's reward for a signup. ZERO, on purpose.
   *
   * This used to be 500 with no gate of any kind: `attributeReferral`
   * (lib/db.ts) credited the inviter the moment a new account presented
   * their code. Creating an account costs an attacker nothing but a
   * Google identity, so 500 pts/signup was a sybil bounty priced at the
   * cost of a browser profile. There were no per-inviter caps, no KYC,
   * no activity requirement and no clawback path.
   *
   * The referral value did not go away, it MOVED to activation
   * (`REFERRAL_FIRST_SEND_*`), which only pays once the referee has
   * moved real money on chain. Attribution itself still writes a
   * 0-point `referral_signup` event so the referral edge stays visible
   * in the feed and in /admin/ledger.
   */
  REFERRAL_SIGNUP_REFERRER: 0,
  /** Referee's reward for a signup. ZERO, same reasoning. */
  REFERRAL_SIGNUP_REFEREE: 0,

  /**
   * ACTIVATION award: paid to BOTH sides, once, when the referee's first
   * server-verified money movement clears (lib/rewards/referral.ts).
   *
   * Why symmetric (500/500) rather than the old 1000/1000 or the
   * referrer-only 500/0:
   *
   *   • The old split was asymmetric in the WRONG direction. The referee
   *     does the work (they're the one who moves money) and got nothing
   *     at signup, so the invite had nothing to offer them, while the
   *     inviter got paid for an action that cost nobody anything.
   *   • A symmetric split does NOT make farming worse. A farmer who owns
   *     both sides collects the whole 1000 either way; what bounds them
   *     is the activation gate + the per-inviter caps below, not how the
   *     payout is sliced. Given that, the split is a product decision,
   *     and "you and your friend each get 500" is the legible one.
   *   • The total per activated referral came DOWN from 2000 (1000+1000)
   *     to 1000, because the payout now happens at the point of proven
   *     value and we'd rather spend the budget on more activations than
   *     on a bigger single bounty.
   */
  REFERRAL_FIRST_SEND_REFERRER: 500,
  REFERRAL_FIRST_SEND_REFEREE: 500,

  /**
   * Personal first-send bonus (no referrer required). Paid once, on the
   * first CHAIN-VERIFIED money movement, never on a self-report.
   */
  FIRST_SEND: 500,
  /** Personal first `name@talise` claim. Server-verified by definition. */
  FIRST_CLAIM: 250,
  /** Daily activity streak, placeholder, not yet wired. */
  STREAK_DAILY: 50,
} as const;

/**
 * Anti-farming limits for the referral programme.
 *
 * Every number here is a deliberate trade between organic word-of-mouth
 * (which we want) and an attacker minting accounts (which we don't).
 * They are constants rather than env vars so a change is reviewable in
 * git history alongside its rationale.
 */
export const REFERRAL_LIMITS = {
  /**
   * Chain-verified USD the REFEREE must have moved (cumulatively, across
   * all their settled awards) before either side is paid.
   *
   * $1.00. The earn engine documents typical corridor sends as
   * ~$0.04-$5, so this is a couple of real sends, not a wall, and it's
   * cumulative so a string of tiny sends qualifies. But it does mean a
   * fake account costs a dollar of real, on-chain, KYC-adjacent money to
   * activate instead of costing nothing. At the lifetime cap below that
   * puts a floor of $50 + 50 Google identities on a maxed-out farm.
   */
  MIN_REFEREE_VERIFIED_USD: 1.0,

  /**
   * Activated referrals one inviter can be paid for per UTC day.
   *
   * 5. Genuine word-of-mouth is a handful of friends a day; nobody
   * organically activates a sixth person before midnight. Caps a burst
   * farm at 5 x 500 = 2,500 pts/day for the inviter side.
   */
  MAX_ACTIVATIONS_PER_DAY: 5,

  /**
   * Activated referrals one inviter can EVER be paid for.
   *
   * 50 (= 25,000 pts, i.e. the whole Platinum tier). Past this, growth is
   * an ambassador conversation with a human, not an automatic faucet.
   * Attribution keeps counting (`users.referral_count`, leaderboard rank)
   * after the cap; only the points stop.
   */
  MAX_ACTIVATIONS_LIFETIME: 50,

  /**
   * Activations an inviter may be paid for before KYC is required.
   *
   * 10 (= 5,000 pts). Rationale: KYC is the only control that ties a
   * payout to a legal identity, and it is the correct friction point for
   * someone earning at scale, but demanding it from a user who invited
   * two friends would kill the loop. Above the threshold the INVITER
   * must have `users.kyc_tier >= MIN_KYC_TIER`; unverified inviters keep
   * accruing attribution and can back-claim nothing (the payout is
   * skipped, not queued, so KYC-then-farm doesn't work either).
   */
  KYC_FREE_ACTIVATIONS: 10,
  MIN_KYC_TIER: 1,
} as const;

/**
 * Per-user daily ceiling on points from MONEY actions (send / invest /
 * roundup / swap).
 *
 * 25,000 pts/day. Every one of those points is backed by verified
 * on-chain movement, so this is not an anti-forgery control, it's an
 * anti-wash-trading one: on a gasless rail a user can bounce funds
 * between two of their own wallets all day at zero marginal cost, and
 * each leg is a genuine outflow. The cap makes that unprofitable while
 * sitting far above any real corridor user (25,000 pts = $25,000 sent, or
 * $8,333 supplied to yield, in one day).
 */
export const DAILY_EARN_POINTS_CAP = 25_000;

/**
 * PERPS CLOSE award policy.
 *
 * ── What is actually verifiable about a WaterX close ────────────────
 *
 * A close is NOT shaped like a send, and most of what a trader cares about
 * is invisible to `balanceChanges`:
 *
 *   • Realized PnL       — NOT verifiable. A reduce-only close settles into
 *     the WaterX Account object's internal CREDIT balance, not into a Coin,
 *     so no `balanceChanges` entry exists for it. (Credit only becomes a
 *     real USDsui balance change later, in a separate withdraw tx that
 *     WaterX's keeper delivers.)
 *   • Collateral returned — NOT verifiable, same reason.
 *   • Position size / entry / mark — client-side numbers. The iOS and web
 *     terminals both compute them from an oracle read for display.
 *
 * Exactly ONE thing about a close is on-chain, unambiguous, and attributable
 * to the user: the 2% Talise close fee. `buildCloseTx` (lib/waterx.ts) reads
 * the position's collateral ON CHAIN (`getPosition(...).collateral_amount`,
 * "not client-trusted") and appends a USDsui `transferObjects` from the
 * user's own wallet to the Talise treasury inside the SAME atomic PTB. That
 * leg lands in `balanceChanges` as a negative delta for the sender and a
 * positive delta for the treasury address.
 *
 * So issuance is based on the FEE PAID, and because the fee is a fixed 2% of
 * chain-read collateral, the fee is also a chain-attested proxy for position
 * size — the award is volume-scaled without ever trusting a client-asserted
 * size or PnL.
 *
 * ── Why this is not farmable ────────────────────────────────────────
 *
 * Perps are the easiest wash-trading surface Talise has: gas is sponsored, so
 * opening and closing in a loop is free. The load-bearing defence is that on
 * THIS trigger it is not free — every point is paid out of a fee the user
 * actually delivered to Talise revenue, verified as an on-chain outflow from
 * their own wallet to the treasury. A wash loop funds its own issuance. On
 * top of that sit the shape gate, the per-day close cap and the minimum fee
 * below (see lib/rewards/earn.ts for the enforcement).
 */
export const PERPS_CLOSE = {
  /**
   * Points per $1 of close fee actually received by the treasury.
   *
   * 25. The fee is 2% of collateral (`PERP_CLOSE_FEE_BPS`, default 200), so
   * 25 pts/$1-of-fee === 0.5 pts per $1 of collateral closed, i.e. HALF the
   * send rate per dollar at risk. Deliberately below the send rate on a new
   * surface, and deliberately not scaled by leverage: notional is a client
   * number, collateral is not.
   *
   * Note this is a LEVERED rate — 25x — so any error in measuring the fee is
   * amplified 25x. That is why the basis is not the transaction's net
   * outflow but the amount the treasury specifically received, and why the
   * shape gate demands the fee be the WHOLE outflow.
   */
  POINTS_PER_FEE_USD: 25,

  /**
   * Smallest fee worth points: $0.02, i.e. a $1 position.
   *
   * The engine floors any positive verified amount to at least 1 pt (real
   * corridor sends are sub-$1), which on a 25x rate would make a dust close
   * worth a point. $1 of collateral is below WaterX's own minimum margin and
   * far below any real Talise position, so nothing legitimate is refused.
   */
  MIN_FEE_USD: 0.02,

  /**
   * Closes one account may be PAID for per UTC day.
   *
   * 20. A real trader closes a handful of positions a day; twenty is
   * generous even for someone scalping. This is a belt-and-braces bound on
   * ledger rows and chain reads a scripted loop can force, independent of
   * the "every point costs real revenue" argument, and it also caps the one
   * remaining way to convert money into points here (hand-crafting treasury
   * transfers) at 20 rows/day.
   */
  MAX_CLOSES_PER_DAY: 20,
} as const;

/**
 * How long a pending (unverified) award stays claimable.
 *
 * 24h. The send rails broadcast with `waitForExecution: false`, so an
 * award almost always races ahead of the fullnode indexing the tx; the
 * award is booked as `pending` and settled by a later pass. A day is
 * generous for chain finality (seconds) plus a user not re-opening the
 * app. After that the row expires unpaid: an award we could never verify
 * is an award we must not pay.
 */
export const PENDING_AWARD_TTL_MS = 24 * 60 * 60 * 1000;

/** Human-readable labels for the activity strip on `/rewards`. */
export const EVENT_LABELS: Record<RewardsEventKind, string> &
  Record<string, string> = {
  referral_signup: "Friend signed up with your code",
  referral_first_send: "Friend sent their first payment",
  volume_milestone: "Volume milestone reached",
  first_send: "Your first send",
  first_claim: "Claimed your @talise name",
  streak: "Daily streak",
  // Phase 1 earn-engine kinds.
  send_earn: "Earned from a send",
  save_earn: "Earned from saving to yield",
  roundup_save: "Round-up saved",
  withdraw_earn: "Withdrew from yield",
  goal_deposit: "Added to a savings goal",
  swap_earn: "Converted to USDsui",
  // Perps close earn. Like `clawback` below, this kind is NOT a member of
  // `RewardsEventKind` (that union lives in lib/db.ts, owned by another work
  // stream); the intersection type above lets us label it anyway so the feed
  // row renders instead of coming out blank.
  perps_close_earn: "Earned from closing a trade",
  redeemed: "Redeemed points",
  // Integrity kind, written by lib/rewards/integrity.ts → clawbackUser.
  // Not a member of `RewardsEventKind` (that union lives in lib/db.ts);
  // the intersection type above lets us label it anyway so a reversal
  // never renders as a blank row.
  clawback: "Points reversed",
};

/** Format a points delta with a leading `+`. */
export function formatPointsDelta(n: number): string {
  if (n <= 0) return `${n}`;
  return `+${n.toLocaleString()}`;
}
