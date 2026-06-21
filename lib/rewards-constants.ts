/**
 * Talise rewards policy — pure constants + presentation helpers.
 *
 * No DB, no fetch, no `server-only` directive. Safe to import from client
 * components (RewardsPanel, OnboardingFlow). The server-side helpers
 * (awardVolumePoints, awardFirstSendBonus, etc.) live in `lib/rewards.ts`
 * which DOES carry the `server-only` pragma because it talks to libSQL.
 */

import type { RewardsEventKind } from "./db";

export const POINTS = {
  /** Inviter earns this when a new user signs in with their code. */
  REFERRAL_SIGNUP_REFERRER: 500,
  /** Referee earns this on signup attribution (so the welcome screen has a win). */
  REFERRAL_SIGNUP_REFEREE: 0,
  /** Both sides earn this once when the referee makes their first send. */
  REFERRAL_FIRST_SEND_REFERRER: 1000,
  REFERRAL_FIRST_SEND_REFEREE: 1000,
  /** Personal first send (any user, no referrer required). */
  FIRST_SEND: 500,
  /** Personal first `name@talise` claim. */
  FIRST_CLAIM: 250,
  /** Per $100 USDsui sent — fired by the volume hook. */
  VOLUME_PER_100_USDSUI: 100,
  /** Daily activity streak — placeholder, not yet wired. */
  STREAK_DAILY: 50,
} as const;

/** Human-readable labels for the activity strip on `/rewards`. */
export const EVENT_LABELS: Record<RewardsEventKind, string> = {
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
  redeemed: "Redeemed points",
};

/** Format a points delta with a leading `+`. */
export function formatPointsDelta(n: number): string {
  if (n <= 0) return `${n}`;
  return `+${n.toLocaleString()}`;
}
