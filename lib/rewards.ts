import "server-only";

import { recordRewardsEvent, userById } from "./db";
import { POINTS } from "./rewards-constants";

// Re-export the constants so existing server-side imports keep working.
export {
  POINTS,
  EVENT_LABELS,
  formatPointsDelta,
} from "./rewards-constants";

/**
 * Server-side rewards helpers. The pure constants + labels live in
 * `lib/rewards-constants.ts` so client components can import them without
 * pulling the `server-only` DB layer into the browser bundle.
 */

/**
 * Fire-and-forget volume hook. Call this from `/api/tx/record` once we know
 * the send's USDsui amount. Awards `POINTS.VOLUME_PER_100_USDSUI` for every
 * full $100 in the transaction.
 *
 * Currently NOT wired to the route, left as a helper so the trigger
 * site can opt in once we settle on accounting (per-tx vs cumulative).
 */
export async function awardVolumePoints(
  userId: number,
  amountUsdsui: number,
  txDigest: string
): Promise<void> {
  if (!Number.isFinite(amountUsdsui) || amountUsdsui < 100) return;
  const hundreds = Math.floor(amountUsdsui / 100);
  const points = hundreds * POINTS.VOLUME_PER_100_USDSUI;
  if (points <= 0) return;
  await recordRewardsEvent(userId, "volume_milestone", points, {
    txDigest,
    amountUsdsui,
    milestone: hundreds * 100,
  });
}

/**
 * Award the one-time "first send" bonus. Caller should ensure this is the
 * user's actual first send (e.g. by checking `tx_history` count == 1) before
 * invoking, we don't re-query that here to keep the helper composable.
 *
 * If the referee was referred, fires `referral_first_send` for both sides.
 */
export async function awardFirstSendBonus(
  userId: number,
  txDigest: string
): Promise<void> {
  const me = await userById(userId);
  if (!me) return;
  await recordRewardsEvent(userId, "first_send", POINTS.FIRST_SEND, {
    txDigest,
  });
  if (me.referred_by_user_id) {
    await recordRewardsEvent(
      userId,
      "referral_first_send",
      POINTS.REFERRAL_FIRST_SEND_REFEREE,
      { txDigest, inviterUserId: me.referred_by_user_id }
    );
    await recordRewardsEvent(
      me.referred_by_user_id,
      "referral_first_send",
      POINTS.REFERRAL_FIRST_SEND_REFERRER,
      { txDigest, referredUserId: userId }
    );
  }
}

/** Award the one-time "first claim" bonus. */
export async function awardFirstClaimBonus(
  userId: number,
  username: string
): Promise<void> {
  await recordRewardsEvent(userId, "first_claim", POINTS.FIRST_CLAIM, {
    username,
  });
}

