import "server-only";

import { db, ensureSchema, type User } from "@/lib/db";
import { awardForTx, POINT_RATES } from "@/lib/rewards/earn";

/**
 * Round-up & Save, Phase 2 v2 (compound-PTB architecture).
 *
 * Every outbound send by an opted-in user auto-supplies a configurable
 * percentage (default 2%, 1-10) of the send amount to NAVI in the SAME
 * PTB. The user signs once for both legs; Onara broadcasts; both land
 * atomically. The user earns 5 pts per $1 swept on top of the 1 pt/$1
 * for the send itself.
 *
 * ── Architecture ────────────────────────────────────────────────────
 *
 * The on-chain leg lives in `/api/send/prepare`: when `roundup_enabled`
 * is on, it appends `appendNaviSupply(tx, sender, roundupUsd)` plus a
 * Payment Kit marker to the send's compound PTB. No delegation key
 * required, the user signs the whole tx once with their ephemeral
 * zkLogin key.
 *
 * The OFF-chain bookkeeping happens in `/api/zk/sponsor-execute` after
 * Onara confirms broadcast. Server reads the server-blessed
 * `meta.roundupUsd` (came from prepare, can't be inflated by a lying
 * client, the actual on-chain supply was for exactly that amount or
 * the PTB would have failed validation), then:
 *   • `users.roundup_saved_usd`  += amount (the RoundupCard's running tally)
 *   • `users.lifetime_saved_usd` += amount (via `awardForTx`)
 *   • `users.points_total`       += 5 pts/$1 (via `awardForTx`)
 *   • a `rewards_events` row with `kind: "roundup_save"`
 *
 * ── Helpers in this file ───────────────────────────────────────────
 *
 *   • `getRoundupConfig(userId)`, read the user's enabled + percentage
 *      + lifetime saved tally. Used by both /api/send/prepare (to
 *      decide whether to append the supply leg) and /api/referral/summary
 *      (to render the RoundupCard).
 *
 *   • `setRoundupConfig(...)`, write the toggle + percentage. Called
 *      from `/api/rewards/roundup` POST.
 *
 *   • `maybeRoundupForSend(...)`, LEGACY (v1 tracking-only path).
 *      Kept temporarily for back-compat; no longer called from the
 *      hot path. Marked `@deprecated`; safe to delete once nothing
 *      references it.
 */

/** Result returned by `maybeRoundupForSend`, useful for tests + logs. */
export type RoundupResult =
  | { swept: false; reason: "disabled" | "no-amount" | "already-applied" | "user-missing" }
  | { swept: true; roundupUsd: number; points: number };

/**
 * If the user has round-up enabled, compute and book the round-up for
 * an outbound send. Returns the outcome (swept / not-swept) for logging.
 *
 * @param userId         Talise user id (numeric, from mobile_sessions)
 * @param sendAmountUsd  USD amount of the parent send (positive)
 * @param sourceDigest   Sui digest of the parent send tx, idempotency key
 */
export async function maybeRoundupForSend(opts: {
  userId: number;
  sendAmountUsd: number;
  sourceDigest: string;
}): Promise<RoundupResult> {
  await ensureSchema();
  const c = db();

  if (!(opts.sendAmountUsd > 0)) {
    return { swept: false, reason: "no-amount" };
  }

  // Read the user's roundup config off the users row. Cheap single-row
  // read, same source the Rewards summary reads.
  const r = await c.execute({
    sql: `SELECT roundup_enabled, roundup_percentage
          FROM users WHERE id = ? LIMIT 1`,
    args: [opts.userId],
  });
  const row = r.rows[0] as unknown as Partial<User> | undefined;
  if (!row) return { swept: false, reason: "user-missing" };

  const enabled = Number(row.roundup_enabled ?? 0) === 1;
  if (!enabled) return { swept: false, reason: "disabled" };

  // Clamp percentage to the documented 1-10 range. Defaults to 2 if the
  // column happens to be 0/NULL (shouldn't happen given the schema
  // default but cheap defense in depth).
  const pctRaw = Number(row.roundup_percentage ?? 2);
  const pct = clamp(Number.isFinite(pctRaw) ? pctRaw : 2, 1, 10);

  // Round to the cent so the event row stays clean.
  const roundupUsd = Math.round(opts.sendAmountUsd * (pct / 100) * 100) / 100;
  if (!(roundupUsd > 0)) return { swept: false, reason: "no-amount" };

  // Idempotency: have we already booked a round-up for this source
  // digest? `awardForTx` writes `{ amountUsd, digest }` into the
  // event's metadata column (JSON-as-text); a substring match on the
  // digest is enough, Sui digests are base58 of a 32-byte hash, so
  // there's effectively zero chance of false-positive collision.
  const dupe = await c.execute({
    sql: `SELECT 1 FROM rewards_events
          WHERE user_id = ?
            AND kind = 'roundup_save'
            AND metadata LIKE ?
          LIMIT 1`,
    args: [opts.userId, `%"digest":"${opts.sourceDigest}"%`],
  });
  if (dupe.rows.length > 0) {
    return { swept: false, reason: "already-applied" };
  }

  // Credit the user, points + lifetime_saved_usd bump + event row.
  // `awardForTx` writes the canonical `roundup_save` event with
  // `{ amountUsd, digest }` metadata. We pass the parent send digest
  // as `digest` so the dedupe LIKE-check above can find it on retry,
  // AND so support has a traceable anchor for "what tx earned these
  // points?".
  const { points } = await awardForTx({
    userId: opts.userId,
    trigger: "roundup",
    amountUsd: roundupUsd,
    digest: opts.sourceDigest,
  });

  // Bump the dedicated round-up lifetime tally. `lifetime_saved_usd`
  // is ALREADY bumped by `awardForTx` (which treats roundup as
  // "saved"); this gives the iOS Rewards card a separate "saved via
  // round-up" sub-number without scanning rewards_events.
  await c.execute({
    sql: `UPDATE users
          SET roundup_saved_usd = COALESCE(roundup_saved_usd, 0) + ?
          WHERE id = ?`,
    args: [roundupUsd, opts.userId],
  });

  // TODO(roundup-onchain): wire the actual NAVI supply. The PTB builder
  // already exists in `web/lib/navi-supply.ts → appendNaviSupply`. The
  // blocker is non-interactive signing, we need either:
  //   (a) a passkey-bound secondary authority the user pre-authorizes
  //   (b) a server-held delegation key gated by an on-chain SpendPolicy
  // Until one of those lands we cannot construct + sponsor-execute the
  // supply without prompting Face ID, which defeats "set and forget".
  // When unblocked: build a Transaction with appendNaviSupply(tx, user.sui_address, roundupUsd),
  // sign via the delegated authority, POST to Onara's /sponsor, then
  // replace the `stub: true` flag above with the real on-chain digest.

  return { swept: true, roundupUsd, points };
}

/**
 * Read the current round-up config for a user. Used by the
 * `/api/rewards/roundup` GET handler.
 */
export async function getRoundupConfig(userId: number): Promise<{
  enabled: boolean;
  percentage: number;
  savedUsd: number;
}> {
  await ensureSchema();
  const r = await db().execute({
    sql: `SELECT roundup_enabled, roundup_percentage, roundup_saved_usd
          FROM users WHERE id = ? LIMIT 1`,
    args: [userId],
  });
  const row = r.rows[0] as unknown as
    | (Partial<User> & { roundup_saved_usd?: number | null })
    | undefined;
  return {
    enabled: Number(row?.roundup_enabled ?? 0) === 1,
    percentage: clamp(Number(row?.roundup_percentage ?? 2) || 2, 1, 10),
    savedUsd: Number(row?.roundup_saved_usd ?? 0) || 0,
  };
}

/**
 * Update the round-up config. Either field is optional, missing
 * fields are left untouched. Returns the post-update shape so the
 * caller can echo it back to the client without a second round-trip.
 */
export async function setRoundupConfig(opts: {
  userId: number;
  enabled?: boolean;
  percentage?: number;
}): Promise<{ enabled: boolean; percentage: number; savedUsd: number }> {
  await ensureSchema();
  const c = db();

  // Build the UPDATE dynamically, only touch the columns the caller
  // actually supplied. Avoids stomping the user's saved % to default
  // when they only toggled the switch.
  const sets: string[] = [];
  const args: (string | number)[] = [];
  if (opts.enabled !== undefined) {
    sets.push("roundup_enabled = ?");
    args.push(opts.enabled ? 1 : 0);
  }
  if (opts.percentage !== undefined) {
    sets.push("roundup_percentage = ?");
    args.push(clamp(opts.percentage, 1, 10));
  }
  if (sets.length > 0) {
    args.push(opts.userId);
    await c.execute({
      sql: `UPDATE users SET ${sets.join(", ")} WHERE id = ?`,
      args,
    });
  }

  return getRoundupConfig(opts.userId);
}

/** Points-per-USD for roundups. Re-export of the rewards engine's rate. */
export const ROUNDUP_POINTS_PER_USD = POINT_RATES.roundup;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
