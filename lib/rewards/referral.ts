import "server-only";

import { db, userById } from "@/lib/db";
import { POINTS, REFERRAL_LIMITS } from "@/lib/rewards-constants";
import {
  claimAward,
  countSettled,
  isFarmingBlocked,
  markSettled,
  qualifyingUsdTotal,
  utcDayStart,
  writeRewardsEvent,
} from "./integrity";

/**
 * Talise Rewards, REFERRAL ACTIVATION.
 *
 * ── What changed and why ────────────────────────────────────────────
 *
 * Before: `attributeReferral` (lib/db.ts) paid the inviter 500 pts the
 * instant a new account presented their code, and the referee 0. No
 * per-inviter cap, no KYC, no activity requirement, no clawback. The
 * marginal cost of a referral was one Google account, so the marginal
 * revenue of a farm was 500 pts per browser profile.
 *
 * Now: signup pays ZERO on both sides (POINTS.REFERRAL_SIGNUP_*), the
 * attribution row is written for audit only, and the money is paid HERE,
 * on ACTIVATION, when the referee's first chain-verified money movement
 * clears. `awardForTx` (lib/rewards/earn.ts) calls in after it settles a
 * verified award; nothing on the request path can reach this.
 *
 * ── Gates, in order ─────────────────────────────────────────────────
 *
 *   1. Neither side is flagged for farming (`rewards_farming_flags`).
 *   2. The referee's CUMULATIVE qualifying USD >= MIN_REFEREE_VERIFIED_USD.
 *      "Qualifying" excludes money that flowed straight back to the
 *      inviter, so inviter-funds-referee-then-referee-pays-inviter-back
 *      (the cheapest circular farm) never qualifies.
 *   3. Inviter is under MAX_ACTIVATIONS_PER_DAY for the UTC day.
 *   4. Inviter is under MAX_ACTIVATIONS_LIFETIME.
 *   5. Past KYC_FREE_ACTIVATIONS, the inviter needs kyc_tier >= MIN_KYC_TIER.
 *
 * A failed gate SKIPS the payout, it never queues it. Otherwise
 * "farm 500 accounts, then KYC once" would still pay out.
 *
 * Every payout is idempotent (UNIQUE `claim_key` per side) and shows up
 * in `rewards_award_ledger` with `trigger_kind = 'referral_activation'`,
 * which is exactly what `clawbackUser({ scope: "policy" })` reverses.
 */

export type ActivationOutcome = {
  /** Points paid to the user whose tx triggered this pass. */
  refereePoints: number;
  /** Points paid to their inviter (0 when there isn't one). */
  referrerPoints: number;
  /** Personal first-send bonus paid on this pass. */
  firstSendPoints: number;
  /** Machine-readable reasons for anything that was skipped. */
  skipped: string[];
};

/**
 * The inviter's wallet address, for the circular-flow check.
 *
 * Returns `null` when the user wasn't referred. Single indexed read on
 * `users`, cheap enough to run per settled award.
 */
export async function inviterAddress(userId: number): Promise<string | null> {
  const r = await db().execute({
    sql: `SELECT inv.sui_address AS addr
          FROM users u
          JOIN users inv ON inv.id = u.referred_by_user_id
          WHERE u.id = ? LIMIT 1`,
    args: [userId],
  });
  const addr = r.rows[0]?.addr as string | undefined;
  return addr ? addr.toLowerCase() : null;
}

/**
 * Pay the one-time activation awards if every gate passes.
 *
 * `digest` is the chain-verified transaction that triggered the pass; it
 * is stamped onto the ledger rows as an audit link (and deliberately
 * ignored by `digestUsage`, see the comment there).
 */
export async function maybeAwardActivation(opts: {
  userId: number;
  digest: string | null;
}): Promise<ActivationOutcome> {
  const out: ActivationOutcome = {
    refereePoints: 0,
    referrerPoints: 0,
    firstSendPoints: 0,
    skipped: [],
  };

  const me = await userById(opts.userId);
  if (!me) {
    out.skipped.push("user_missing");
    return out;
  }

  // Gate 1 (referee side) + gate 2 are shared by both awards below, so
  // evaluate them once.
  if (await isFarmingBlocked(opts.userId)) {
    out.skipped.push("referee_flagged");
    return out;
  }
  const qualifying = await qualifyingUsdTotal(opts.userId);
  if (qualifying < REFERRAL_LIMITS.MIN_REFEREE_VERIFIED_USD) {
    out.skipped.push(
      `below_min_verified_usd(${qualifying.toFixed(4)}<${REFERRAL_LIMITS.MIN_REFEREE_VERIFIED_USD})`
    );
    return out;
  }

  // ── Personal first-send bonus ─────────────────────────────────────
  // Claimed only AFTER the activity gate passes, so a sub-threshold
  // first send doesn't burn the one-and-only claim key on a 0-pt row.
  const firstSend = await claimAward({
    userId: opts.userId,
    triggerKind: "first_send",
    claimKey: `first_send:${opts.userId}`,
    digest: opts.digest,
  });
  if (firstSend) {
    // `markSettled` returning false means a concurrent pass already paid
    // this row; the points must be minted exactly once.
    const won = await markSettled({
      id: firstSend.id,
      verifiedUsd: 0,
      creditedUsd: 0,
      qualifyingUsd: 0,
      points: POINTS.FIRST_SEND,
      reason: `activation via ${opts.digest ?? "verified award"}`,
    });
    if (won) {
      await writeRewardsEvent({
        userId: opts.userId,
        kind: "first_send",
        points: POINTS.FIRST_SEND,
        metadata: { digest: opts.digest, verifiedUsd: qualifying },
      });
      out.firstSendPoints = POINTS.FIRST_SEND;
    }
  }

  // ── Referral activation ───────────────────────────────────────────
  const inviterId = me.referred_by_user_id ?? null;
  if (!inviterId) return out;
  if (inviterId === opts.userId) {
    // Belt-and-braces: `attributeReferral` already rejects self-referral.
    out.skipped.push("self_referral");
    return out;
  }

  const inviter = await userById(inviterId);
  if (!inviter) {
    out.skipped.push("inviter_missing");
    return out;
  }
  if (await isFarmingBlocked(inviterId)) {
    out.skipped.push("inviter_flagged");
    return out;
  }

  // Gates 3-5, all on the inviter.
  const lifetime = await countSettled(inviterId, "referral_activation");
  if (lifetime >= REFERRAL_LIMITS.MAX_ACTIVATIONS_LIFETIME) {
    out.skipped.push(`inviter_lifetime_cap(${lifetime})`);
    return out;
  }
  const today = await countSettled(
    inviterId,
    "referral_activation",
    utcDayStart()
  );
  if (today >= REFERRAL_LIMITS.MAX_ACTIVATIONS_PER_DAY) {
    out.skipped.push(`inviter_daily_cap(${today})`);
    return out;
  }
  if (lifetime >= REFERRAL_LIMITS.KYC_FREE_ACTIVATIONS) {
    const tier = Number(inviter.kyc_tier ?? 0) || 0;
    if (tier < REFERRAL_LIMITS.MIN_KYC_TIER) {
      out.skipped.push(`inviter_kyc_required(tier=${tier})`);
      return out;
    }
  }

  // Claim the inviter side first; it is the row the caps are counted
  // from, so whoever wins it owns the whole activation.
  const referrerRow = await claimAward({
    userId: inviterId,
    triggerKind: "referral_activation",
    claimKey: `referral_activation:referrer:${inviterId}:${opts.userId}`,
    digest: opts.digest,
  });
  if (!referrerRow) {
    out.skipped.push("already_activated");
    return out;
  }

  const refereeRow = await claimAward({
    userId: opts.userId,
    triggerKind: "referral_activation",
    claimKey: `referral_activation:referee:${opts.userId}`,
    digest: opts.digest,
  });

  const wonReferrer = await markSettled({
    id: referrerRow.id,
    verifiedUsd: 0,
    creditedUsd: 0,
    qualifyingUsd: 0,
    points: POINTS.REFERRAL_FIRST_SEND_REFERRER,
    reason: `referee=${opts.userId} digest=${opts.digest ?? "-"}`,
  });
  if (wonReferrer) {
    await writeRewardsEvent({
      userId: inviterId,
      kind: "referral_first_send",
      points: POINTS.REFERRAL_FIRST_SEND_REFERRER,
      metadata: {
        referredUserId: opts.userId,
        digest: opts.digest,
        refereeVerifiedUsd: qualifying,
        activationIndex: lifetime + 1,
      },
    });
    out.referrerPoints = POINTS.REFERRAL_FIRST_SEND_REFERRER;
  }

  if (refereeRow) {
    const wonReferee = await markSettled({
      id: refereeRow.id,
      verifiedUsd: 0,
      creditedUsd: 0,
      qualifyingUsd: 0,
      points: POINTS.REFERRAL_FIRST_SEND_REFEREE,
      reason: `inviter=${inviterId} digest=${opts.digest ?? "-"}`,
    });
    if (wonReferee) {
      await writeRewardsEvent({
        userId: opts.userId,
        kind: "referral_first_send",
        points: POINTS.REFERRAL_FIRST_SEND_REFEREE,
        metadata: { inviterUserId: inviterId, digest: opts.digest },
      });
      out.refereePoints = POINTS.REFERRAL_FIRST_SEND_REFEREE;
    }
  } else {
    // Referee side already paid (e.g. their attribution was re-pointed).
    // The inviter row above is the authoritative one; nothing to undo.
    out.skipped.push("referee_side_already_paid");
  }

  return out;
}
