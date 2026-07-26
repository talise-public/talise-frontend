import "server-only";

import { db, ensureSchema, userById } from "@/lib/db";
import { findSku, type RedeemSKU } from "./catalogue";
import { tierForPoints } from "./earn";
import { isFarmingBlocked } from "./integrity";

/**
 * Talise Rewards, redemption (Phase 4).
 *
 * Spend `points_total` against a catalogue SKU:
 *
 *   1. Validate user exists, SKU is in the catalogue + enabled, the
 *      account isn't flagged for farming, the user clears the SKU's tier
 *      gate, and they're not inside the 5-minute debounce window for the
 *      same SKU (defeats double-tap on the iOS card).
 *   2. Validate non-stackable SKUs aren't already active (the user
 *      can't double-redeem `fx_boost_3bp_30d` while a previous one is
 *      still valid).
 *   3. DEBIT THE POINTS ATOMICALLY (see below), then insert the
 *      `redemptions` row + the negative `rewards_events` row.
 *
 * ── 2026-07-25: the debit is now atomic ─────────────────────────────
 *
 * It used to be: read `points_total`, compare to cost, and later call
 * `recordRewardsEvent(userId, "redeemed", -cost)` which does an
 * unconditional `points_total = points_total + (-cost)`. Two concurrent
 * redeems both passed the read and both deducted, so the balance could go
 * NEGATIVE and the user got two perks for one balance. The old note here
 * argued the 5-minute debounce made that acceptable; it doesn't — the
 * debounce is per-SKU and the race window is one network round-trip, not
 * five minutes.
 *
 * Now the deduction itself is the affordability check:
 *
 *   UPDATE users SET points_total = points_total - cost
 *   WHERE id = ? AND COALESCE(points_total, 0) >= cost RETURNING points_total
 *
 * Zero rows back = insufficient funds, and only one of two racing
 * requests can win. `catalogue.ts` names an atomic debit as a
 * precondition for ever re-adding a points→value SKU; this is it.
 */

export type RedemptionRow = {
  id: number;
  user_id: number;
  sku: string;
  points_spent: number;
  status: "pending" | "fulfilled" | "expired" | "refunded";
  metadata: string | null;
  created_at: number;
  fulfilled_at: number | null;
};

export class RedeemError extends Error {
  code:
    | "user_not_found"
    | "unknown_sku"
    | "sku_disabled"
    | "insufficient_points"
    | "debounced"
    | "already_active"
    | "tier_locked"
    /** Account is flagged for reward farming; redemptions are frozen. */
    | "account_flagged";
  status: number;
  constructor(
    code: RedeemError["code"],
    message: string,
    status = 400
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const DEBOUNCE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Read the user's last redemption of `sku` if it landed in the
 * debounce window. Cheap, single indexed query.
 */
async function recentRedemption(
  userId: number,
  sku: string,
  windowMs: number
): Promise<RedemptionRow | null> {
  const cutoff = Date.now() - windowMs;
  const r = await db().execute({
    sql: `SELECT * FROM redemptions
          WHERE user_id = ? AND sku = ? AND created_at > ?
          ORDER BY created_at DESC LIMIT 1`,
    args: [userId, sku, cutoff],
  });
  return (r.rows[0] as unknown as RedemptionRow) ?? null;
}

/**
 * Is there an active (non-expired, non-refunded) redemption of this
 * SKU? Drives the non-stackable check. For flagged perks with a
 * `durationMs`, "active" means within the time window from the
 * stamped `activeUntilMs`.
 */
async function isAlreadyActive(
  userId: number,
  sku: RedeemSKU
): Promise<boolean> {
  if (sku.stackable) return false;
  const now = Date.now();
  const r = await db().execute({
    sql: `SELECT id, status, metadata, created_at FROM redemptions
          WHERE user_id = ? AND sku = ?
            AND status IN ('pending', 'fulfilled')
          ORDER BY created_at DESC`,
    args: [userId, sku.sku],
  });
  for (const row of r.rows) {
    const meta = (row as unknown as { metadata: string | null }).metadata;
    let activeUntilMs: number | null = null;
    if (meta) {
      try {
        const parsed = JSON.parse(meta) as { activeUntilMs?: number };
        if (typeof parsed.activeUntilMs === "number") {
          activeUntilMs = parsed.activeUntilMs;
        }
      } catch {
        /* malformed metadata, treat as no expiry */
      }
    }
    // No `activeUntilMs` stamped → treat as permanent (e.g. early_access_v2).
    if (activeUntilMs == null) return true;
    if (activeUntilMs > now) return true;
  }
  return false;
}

export interface RedeemResult {
  redemption: RedemptionRow;
  newPointsTotal: number;
}

export async function redeemSku(opts: {
  userId: number;
  sku: string;
}): Promise<RedeemResult> {
  await ensureSchema();

  const entry = findSku(opts.sku);
  if (!entry) {
    throw new RedeemError("unknown_sku", `unknown sku: ${opts.sku}`, 404);
  }
  if (!entry.enabled) {
    throw new RedeemError("sku_disabled", `sku not available`, 410);
  }

  const user = await userById(opts.userId);
  if (!user) {
    throw new RedeemError("user_not_found", "user not found", 404);
  }
  const points = Number(user.points_total ?? 0) || 0;
  if (entry.pointsCost > points) {
    throw new RedeemError(
      "insufficient_points",
      `need ${entry.pointsCost} pts, have ${points}`,
      402
    );
  }

  // An account under farming review cannot convert points to value while
  // the review is open. Without this, a clawback is a race against the
  // farmer's redeem button.
  if (await isFarmingBlocked(opts.userId)) {
    throw new RedeemError(
      "account_flagged",
      "redemptions are temporarily unavailable on this account",
      403
    );
  }

  // Tier gate. `RedeemSKU.minTier` and the `tier_locked` error code both
  // existed but nothing ever enforced them, so any tier-gated SKU added
  // to the catalogue would have been redeemable by everyone.
  if (entry.minTier) {
    const order: Array<RedeemSKU["minTier"]> = ["bronze", "silver", "gold", "plat"];
    const have = order.indexOf(tierForPoints(points).id);
    const need = order.indexOf(entry.minTier);
    if (have < need) {
      throw new RedeemError(
        "tier_locked",
        `requires ${entry.minTier} tier`,
        403
      );
    }
  }

  // 5-minute debounce, double-tap on the confirm sheet, fat-fingered
  // duplicates, retries on a network flake. We don't want any of those
  // to charge twice.
  const recent = await recentRedemption(opts.userId, opts.sku, DEBOUNCE_WINDOW_MS);
  if (recent) {
    throw new RedeemError(
      "debounced",
      `recently redeemed, try again in a few minutes`,
      429
    );
  }

  if (await isAlreadyActive(opts.userId, entry)) {
    throw new RedeemError(
      "already_active",
      `this perk is already active`,
      409
    );
  }

  // Build the metadata payload. For flagged SKUs with a duration, we
  // stamp `activeUntilMs` so future policy checks (e.g. fx-boost
  // application in the FX router) can read it without re-deriving.
  const now = Date.now();
  const metadata: Record<string, unknown> = {
    sku: entry.sku,
    label: entry.label,
    pointsCost: entry.pointsCost,
    kind: entry.kind,
  };
  if (entry.durationMs) {
    metadata.activeUntilMs = now + entry.durationMs;
  }
  // Tag known flagged-perks with a group name so a future audit query
  // can `WHERE json_extract(metadata, '$.group') = 'early_access'`.
  if (entry.sku === "early_access_v2") metadata.group = "early_access";
  if (entry.sku === "gold_tier_skip") metadata.tierOverride = "gold";

  const status: RedemptionRow["status"] =
    entry.kind === "pending" ? "pending" : "fulfilled";
  const fulfilledAt = status === "fulfilled" ? now : null;

  const c = db();

  // ── ATOMIC DEBIT ───────────────────────────────────────────────────
  // The deduction IS the affordability check. Two concurrent redeems can
  // no longer both pass: the second one sees zero rows back and 402s
  // instead of driving `points_total` negative.
  const debit = await c.execute({
    sql: `UPDATE users
          SET points_total = COALESCE(points_total, 0) - ?
          WHERE id = ? AND COALESCE(points_total, 0) >= ?
          RETURNING points_total`,
    args: [entry.pointsCost, opts.userId, entry.pointsCost],
  });
  if (debit.rows.length === 0) {
    throw new RedeemError(
      "insufficient_points",
      `need ${entry.pointsCost} pts`,
      402
    );
  }
  // Now record it: the redemption row + the negative feed row, in one
  // transaction. `points_total` is NOT touched here (already debited
  // above), so this cannot deduct twice.
  try {
    await c.batch(
      [
        {
          sql: `INSERT INTO redemptions
              (user_id, sku, points_spent, status, metadata, created_at, fulfilled_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            opts.userId,
            entry.sku,
            entry.pointsCost,
            status,
            JSON.stringify(metadata),
            now,
            fulfilledAt,
          ],
        },
        {
          sql: `INSERT INTO rewards_events
              (user_id, kind, points, metadata, created_at)
              VALUES (?, 'redeemed', ?, ?, ?)`,
          args: [
            opts.userId,
            -entry.pointsCost,
            JSON.stringify(metadata),
            now,
          ],
        },
      ],
      "write"
    );
  } catch (e) {
    // Compensating re-credit: we took the points but failed to record
    // what they bought, so give them back rather than leaving the user
    // short with no receipt.
    await c
      .execute({
        sql: `UPDATE users SET points_total = COALESCE(points_total, 0) + ? WHERE id = ?`,
        args: [entry.pointsCost, opts.userId],
      })
      .catch((re) =>
        console.error(
          `[rewards/redeem] REFUND FAILED user=${opts.userId} sku=${entry.sku} pts=${entry.pointsCost}:`,
          (re as Error).message
        )
      );
    throw e;
  }

  // Re-read the inserted redemption (we filed it `now`, and that's the
  // sort key). Tolerant of the rare case where another writer
  // beats us by a millisecond, we still pick the row by created_at +
  // sku.
  const after = await c.execute({
    sql: `SELECT * FROM redemptions
          WHERE user_id = ? AND sku = ? AND created_at = ?
          ORDER BY id DESC LIMIT 1`,
    args: [opts.userId, entry.sku, now],
  });
  const redemption = after.rows[0] as unknown as RedemptionRow;

  // Re-read points_total so the response is canonical (rather than
  // computing `points - cost` and hoping nothing else moved).
  const refreshed = await c.execute({
    sql: "SELECT points_total FROM users WHERE id = ? LIMIT 1",
    args: [opts.userId],
  });
  const newPointsTotal =
    Number(refreshed.rows[0]?.points_total ?? 0) || 0;

  return { redemption, newPointsTotal };
}
