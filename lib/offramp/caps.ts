import "server-only";

import { OFFRAMP_MAX_USD, OFFRAMP_WINDOW_MS } from "@/lib/linq";

import { sumRecentAttemptUsd } from "./store";

/**
 * ALL-RAILS daily off-ramp cap.
 *
 * THE HOLE THIS CLOSES
 * --------------------
 * `lib/linq.checkDailyOfframpCap` sums `linq_offramps` only. That table has one
 * writer: the Linq NGN rail. So the Bridge USD/EUR cash-out path
 * (`/api/offramp/bridge/send-usdc-prepare`) consumed NO allowance and was bounded
 * by NOTHING except a rate limit — a user could cash out unlimited USD while the
 * "per-account $200/day" cap was, on paper, enforced. Low blast radius today
 * (USD withdrawal is allowlisted to one handle) but it is a cap that silently
 * does not exist, which is worse than no cap: it makes the limit look enforced.
 *
 * This module sums BOTH ledgers:
 *   • `linq_offramps`      , the NGN rail (via db.sumRecentOfframpUsd)
 *   • `offramp_attempts`   , every other rail (via store.sumRecentAttemptUsd)
 *
 * Linq attempts are excluded from the second sum so a Linq payout that appears in
 * both tables is not counted twice.
 */

export interface CapVerdict {
  ok: boolean;
  used: number;
  remaining: number;
  max: number;
  error?: string;
  code?: string;
}

/**
 * Check a proposed cash-out of `addUsd` against the user's trailing-24h usage
 * across every fiat-out rail.
 *
 * FAILS CLOSED: if either ledger read throws we refuse. An unreadable ledger
 * means we cannot prove the user is under their limit, and on a money path
 * "cannot prove" must mean "no".
 */
export async function checkDailyOfframpCapAllRails(
  userId: number | string,
  addUsd: number
): Promise<CapVerdict> {
  const since = Date.now() - OFFRAMP_WINDOW_MS;
  let used: number;
  try {
    const { sumRecentOfframpUsd } = await import("@/lib/db");
    const [linqUsd, otherUsd] = await Promise.all([
      sumRecentOfframpUsd(userId, since),
      sumRecentAttemptUsd(userId, since, { excludeProvider: "linq" }),
    ]);
    used = linqUsd + otherUsd;
  } catch (e) {
    console.error(
      `[offramp/caps] cap ledger unreadable for user=${userId}, refusing:`,
      (e as Error).message
    );
    return {
      ok: false,
      used: 0,
      remaining: 0,
      max: OFFRAMP_MAX_USD,
      error: "We couldn't verify your daily cash-out limit. Please try again shortly.",
      code: "CAP_CHECK_UNAVAILABLE",
    };
  }

  const remaining = Math.max(0, OFFRAMP_MAX_USD - used);
  const ok = addUsd <= remaining + 1e-9;
  return {
    ok,
    used,
    remaining,
    max: OFFRAMP_MAX_USD,
    ...(ok
      ? {}
      : {
          error: `Cash-outs are capped at $${OFFRAMP_MAX_USD} per day. You have $${remaining.toFixed(2)} left today, verify your identity (KYC) to raise your limit.`,
          code: "OFFRAMP_DAILY_CAP",
        }),
  };
}
