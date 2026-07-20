import "server-only";

import { db, ensureSchema, recordRewardsEvent, type User } from "@/lib/db";

/**
 * Talise Rewards, earn engine.
 *
 * Wires up the "you spend, you earn" loop that the original
 * referral-only rewards system was missing. Every successful sponsored
 * tx now mints a `rewards_events` row + bumps lifetime tallies on the
 * user row, which the Rewards tab reads to render points balance,
 * monthly saved/spent, and tier.
 *
 * Called from `/api/zk/sponsor-execute` after Onara confirms broadcast
 *, we only credit settled work, not the build step. If the row write
 * fails, we swallow the error: rewards are nice-to-have, the user's
 * money already moved.
 *
 * ── Earn rules (Phase 1) ───────────────────────────────────────────
 *
 *   send      → 1  pt per $1 outbound  (`kind: "send_earn"`)
 *   invest    → 3  pts per $1 supplied (`kind: "save_earn"`)
 *   withdraw  → 0  pts                  (`kind: "withdraw_earn"`, logged)
 *   roundup   → 5  pts per $1 swept     (`kind: "roundup_save"`)
 *   goal      → 4  pts per $1 deposited (`kind: "goal_deposit"`)
 *
 * Rates are intentionally biased toward saving, sends are the funnel,
 * but saves are the behavior we want to reinforce. We'll tune from
 * usage data; for now the numbers are documented in `POINT_RATES`
 * so the iOS Rewards card can render them too.
 */

/** What kind of motion triggered the earn. Maps 1:1 to the iOS TxKind. */
export type EarnTrigger = "send" | "invest" | "withdraw" | "roundup" | "goal" | "swap";

/**
 * Points-per-USD rates keyed by trigger. The rates intentionally bias
 * toward saving, sends are the funnel, but saves are the behavior we
 * want to reinforce. Exported so iOS can render "earn 3 pts per $1
 * saved" without duplicating the values.
 */
export const POINT_RATES: Record<EarnTrigger, number> = {
  send: 1,
  invest: 3,
  withdraw: 0,
  roundup: 5,
  // Goal deposits earn NOTHING. A goal deposit is an UNVERIFIED self-report
  // (no money moves on-chain), so awarding points for it is freely farmable -
  // one account rigged it to 1,008,671,212 pts. Tracking still works; points
  // don't. (Closes the "goal" trigger on sponsor-execute too.)
  goal: 0,
  // Auto-swap into USDsui (Cetus), reward the conversion that puts the
  // user into the spendable/savable stablecoin. 1 pt per $1 converted.
  swap: 1,
};

/**
 * Mint a rewards_events row + bump the user's lifetime tally for a
 * settled tx. Returns the points awarded (0 for withdraw / non-positive
 * amounts) so the caller can include it in the response if it wants
 * to (handy for an inline "+12 pts" toast on the success screen).
 *
 * Idempotency: we DON'T dedupe by digest here. The caller is the
 * sponsor-execute route which only invokes this on success, duplicate
 * sponsor-execute calls would be a much bigger bug. If we ever process
 * webhooks or chain-indexer events we'll add a `(user_id, digest)`
 * UNIQUE on a side table.
 */
export async function awardForTx(opts: {
  userId: number;
  trigger: EarnTrigger;
  /** USD amount that moved. Always positive; we infer sign from trigger. */
  amountUsd: number;
  /** Tx digest for the audit trail. */
  digest?: string;
  /** Venue (`navi`, `deepbook`) for invest/withdraw, optional. */
  venue?: string;
}): Promise<{ points: number }> {
  await ensureSchema();

  // Guard: zero/negative amount → no-op (don't write a noise row).
  if (!(opts.amountUsd > 0)) return { points: 0 };

  const rate = POINT_RATES[opts.trigger] ?? 0;
  // Floor to whole points, but always award at least 1 pt for a
  // positive trigger amount (when the rate itself is non-zero -
  // withdraws have rate 0 and stay at 0).
  //
  // Earlier revision used a bare `Math.floor` which silently zeroed
  // out every sub-$1 action, the exact realistic case for the
  // African remittance corridor, where typical sends are ~$0.04-$5
  // USD-equivalent. The user reported "points count broken"; the
  // events were writing fine, the math was rounding their action
  // to 0 pts. Min-1 fixes that without changing the linear scaling
  // for larger sends ($10 → 10 pts, $100 → 100 pts, $1000 → 1000 pts).
  let points = Math.floor(opts.amountUsd * rate);
  if (rate > 0 && points < 1) {
    points = 1;
  }

  const meta: Record<string, unknown> = { amountUsd: opts.amountUsd };
  if (opts.digest) meta.digest = opts.digest;
  if (opts.venue) meta.venue = opts.venue;

  const kind =
    opts.trigger === "send" ? "send_earn"
    : opts.trigger === "invest" ? "save_earn"
    : opts.trigger === "withdraw" ? "withdraw_earn"
    : opts.trigger === "roundup" ? "roundup_save"
    : opts.trigger === "swap" ? "swap_earn"
    : "goal_deposit";

  // Always write the event row (even when points === 0), it's the
  // activity-feed source of truth for Rewards. recordRewardsEvent
  // also bumps `users.points_total` so a 0-pt row is a clean no-op
  // on the balance.
  await recordRewardsEvent(opts.userId, kind, points, meta);

  // Bump the lifetime tally on `users`. This is what the Rewards tab
  // reads to render "Lifetime saved" without scanning every event.
  // Send / roundup / goal-deposit / save all count as "saved" except
  // sends (those count as "spent"); withdraws don't move either tally
  // (the money moves back to the user's own wallet, not out).
  const c = db();
  if (opts.trigger === "send") {
    await c.execute({
      sql: "UPDATE users SET lifetime_sent_usd = COALESCE(lifetime_sent_usd, 0) + ? WHERE id = ?",
      args: [opts.amountUsd, opts.userId],
    });
  } else if (opts.trigger === "invest" || opts.trigger === "roundup" || opts.trigger === "goal") {
    await c.execute({
      sql: "UPDATE users SET lifetime_saved_usd = COALESCE(lifetime_saved_usd, 0) + ? WHERE id = ?",
      args: [opts.amountUsd, opts.userId],
    });
  }

  return { points };
}

/** Tier thresholds. Computed from `points_total`. */
export const TIERS = [
  { id: "bronze", min: 0,     label: "Bronze" },
  { id: "silver", min: 500,   label: "Silver" },
  { id: "gold",   min: 2500,  label: "Gold" },
  { id: "plat",   min: 10000, label: "Platinum" },
] as const;

export type TierId = (typeof TIERS)[number]["id"];

export function tierForPoints(points: number): {
  id: TierId;
  label: string;
  /** Points needed to reach the next tier. Null at top tier. */
  pointsToNext: number | null;
  nextLabel: string | null;
} {
  // Find the highest threshold the user has crossed.
  let i = 0;
  for (let k = TIERS.length - 1; k >= 0; k--) {
    if (points >= TIERS[k].min) {
      i = k;
      break;
    }
  }
  const current = TIERS[i];
  const next = TIERS[i + 1];
  return {
    id: current.id,
    label: current.label,
    pointsToNext: next ? next.min - points : null,
    nextLabel: next?.label ?? null,
  };
}

/**
 * Read the lifetime tallies + tier for a user. Cheap, one query on
 * the users row. Cached in the rewards summary response.
 */
export async function getRewardsExtras(userId: number): Promise<{
  lifetimeSentUsd: number;
  lifetimeSavedUsd: number;
  roundupEnabled: boolean;
  roundupPercentage: number;
  tier: ReturnType<typeof tierForPoints>;
}> {
  await ensureSchema();
  const r = await db().execute({
    sql: `SELECT lifetime_sent_usd, lifetime_saved_usd,
                 roundup_enabled, roundup_percentage, points_total
          FROM users WHERE id = ? LIMIT 1`,
    args: [userId],
  });
  const row = r.rows[0] as unknown as Partial<User> & {
    points_total?: number | null;
  } | undefined;
  return {
    lifetimeSentUsd: Number(row?.lifetime_sent_usd ?? 0) || 0,
    lifetimeSavedUsd: Number(row?.lifetime_saved_usd ?? 0) || 0,
    roundupEnabled: Number(row?.roundup_enabled ?? 0) === 1,
    roundupPercentage: Number(row?.roundup_percentage ?? 2) || 2,
    tier: tierForPoints(Number(row?.points_total ?? 0) || 0),
  };
}
