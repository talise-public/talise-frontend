import "server-only";

/**
 * Server-side rewards surface.
 *
 * The pure policy constants + labels live in `lib/rewards-constants.ts`
 * so client components can import them without pulling the `server-only`
 * DB layer into the browser bundle. This module re-exports them so the
 * existing server-side imports (`@/lib/rewards`, used by
 * `/api/onboarding` and `lib/auth-exchange.ts`) keep working.
 *
 * ── 2026-07-25: three award helpers were DELETED from this file ─────
 *
 * All three had ZERO callers. A `TODO(rewards)` in
 * `/api/tx/record/route.ts` (~line 163) had been promising to wire two of
 * them "once we settle on a USDsui amount normalization" — that TODO is
 * now wrong and the code it referred to is gone. Recorded here rather
 * than in a commit message because the reasoning is the useful part:
 *
 *   • `awardVolumePoints(userId, amountUsdsui, txDigest)`
 *     Awarded `POINTS.VOLUME_PER_100_USDSUI` (100 pts) per full $100
 *     sent. DELETED, not wired, because that is the SAME rate the earn
 *     engine already pays for a send (`POINT_RATES.send` = 1 pt/$1 =
 *     100 pts/$100). Wiring it into `/api/tx/record` as the TODO
 *     suggested would have paid twice for one movement of money, and
 *     paid it from the client-submitted `body.amount` string, which is
 *     precisely the self-report class of bug we just closed. The
 *     `VOLUME_PER_100_USDSUI` constant went with it.
 *
 *   • `awardFirstSendBonus(userId, txDigest)`
 *     Wrote `first_send` + both sides of `referral_first_send` with no
 *     idempotency, no caps, and no verification that a send had actually
 *     happened — its own doc-comment said "Caller should ensure this is
 *     the user's actual first send". DELETED HERE and genuinely WIRED
 *     elsewhere: `lib/rewards/referral.ts → maybeAwardActivation` does
 *     the same job, called from `lib/rewards/earn.ts` only after an award
 *     has been settled against a chain-verified transaction, behind a
 *     UNIQUE claim key, per-inviter daily + lifetime caps, a KYC gate,
 *     and a minimum-verified-volume gate on the referee.
 *
 *   • `awardFirstClaimBonus(userId, username)`
 *     Wrote `first_claim` for `POINTS.FIRST_CLAIM`. DELETED as dead code.
 *     Unlike the other two this one is safe in principle — a `@talise`
 *     handle claim IS server-verified, the server mints the SuiNS subname
 *     and writes `users.talise_username` itself — so `POINTS.FIRST_CLAIM`
 *     survives as reserved policy. To issue it, call
 *     `claimAward({ triggerKind: "first_claim", claimKey: `first_claim:${userId}` })`
 *     from the handle-claim path and mint on the win; do NOT reintroduce
 *     a bare `recordRewardsEvent` call, which is what made the old helper
 *     double-creditable on retry.
 */

// Re-export the constants so existing server-side imports keep working.
export {
  POINTS,
  REFERRAL_LIMITS,
  DAILY_EARN_POINTS_CAP,
  PENDING_AWARD_TTL_MS,
  EVENT_LABELS,
  formatPointsDelta,
} from "./rewards-constants";
