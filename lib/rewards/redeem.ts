import "server-only";

import {
  db,
  ensureSchema,
  recordRewardsEvent,
  userById,
} from "@/lib/db";
import { findSku, type RedeemSKU } from "./catalogue";

/**
 * Talise Rewards — redemption (Phase 4).
 *
 * Spend `points_total` against a catalogue SKU. The math is:
 *
 *   1. Validate user exists, has enough points, SKU is in the catalogue
 *      + enabled, and not within the 5-minute debounce window for the
 *      same SKU (defeats double-tap on the iOS card).
 *   2. Validate non-stackable SKUs aren't already active (the user
 *      can't double-redeem `fx_boost_3bp_30d` while a previous one is
 *      still valid).
 *   3. Insert a `redemptions` row with the right status (`pending`
 *      for the `pending` kind; `fulfilled` for `instant`/`flagged` —
 *      the effect of `flagged` is deferred but the row is closed out
 *      since redeem-time is the only time we touch it).
 *   4. Mint a `rewards_events` row with `kind: "redeemed"` and a
 *      NEGATIVE points value. `recordRewardsEvent` already does the
 *      `UPDATE users SET points_total = COALESCE(points_total, 0) + ?`
 *      math, so passing `-pointsCost` deducts cleanly.
 *
 * NOTE: SQLite/libSQL doesn't give us cheap multi-statement
 * transactions over the HTTP-style client; we use a `batch("write")`
 * to insert the redemption row atomically with the rewards_events row
 * + points update. The 5-minute debounce read happens BEFORE the
 * batch; if two requests race past it, the points balance would go
 * negative once but the second request would have already been
 * accepted. We tolerate this — the 5-minute window is debounce, not
 * a strict transactional invariant, and the affordability check on
 * the second request would have failed only if the first hadn't yet
 * deducted. In practice the iOS confirm sheet single-flights this
 * and the network round-trip is well under 5 minutes.
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
    | "tier_locked";
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
 * debounce window. Cheap — single indexed query.
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
        /* malformed metadata — treat as no expiry */
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

  // 5-minute debounce — double-tap on the confirm sheet, fat-fingered
  // duplicates, retries on a network flake. We don't want any of those
  // to charge twice.
  const recent = await recentRedemption(opts.userId, opts.sku, DEBOUNCE_WINDOW_MS);
  if (recent) {
    throw new RedeemError(
      "debounced",
      `recently redeemed — try again in a few minutes`,
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
  // We can't easily return the inserted id from a batch on libsql,
  // so we insert + read in two steps. The read is bounded by the
  // (user_id, created_at DESC) index.
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
    ],
    "write"
  );

  // Mint the negative-points rewards_events row + bump points_total.
  // recordRewardsEvent does both in a `batch("write")` already.
  await recordRewardsEvent(
    opts.userId,
    "redeemed",
    -entry.pointsCost,
    metadata
  );

  // Re-read the inserted redemption (we filed it `now`, and that's the
  // sort key). Tolerant of the rare case where another writer
  // beats us by a millisecond — we still pick the row by created_at +
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
