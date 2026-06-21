/**
 * Treasury / float-ledger model for Talise (cross-border master plan §6).
 *
 * "Instant" cross-border is pre-positioned destination-currency FLOAT on
 * both legs of a directed corridor, drawn down on authorization and
 * reconciled behind the user. The chain is the net-settlement rail
 * BETWEEN Talise's own float pools — the structural edge over SWIFT
 * correspondent banking (much less dead nostro/vostro working capital).
 *
 * This module is the data model + the invariants, NOT live treasury ops.
 * Balances are MOCK: no real money moves through `float_pools` yet. The
 * point is to encode the shape (per-corridor, per-currency, per-leg
 * inventory) and — the part that actually matters for survival — the
 * SAFEGUARDING invariant: safeguarded client-money balances CANNOT be
 * lent into NAVI (master plan §5/§6/§9). `assertNotLendable()` is the
 * code-level guard that any NAVI-supply path must call before routing a
 * pool's USDC into yield.
 *
 *   • recordInflow  — credit a pool (fiat collected, or USDC minted in)
 *   • recordOutflow — debit a pool (fiat paid out, or USDC settled out)
 *   • getPoolState  — read the current inventory for one pool
 *   • needsRebalance — is a pool under-funded or stale past a threshold?
 *   • assertNotLendable — throw if a pool's balance is safeguarded
 *
 * Pool inventory has three buckets per the float model:
 *   fiat_in_pool   funding-leg fiat collected from senders
 *   fiat_out_pool  payout-leg fiat pre-positioned for recipients
 *   usdc_pool      native USDC inventory for the on-chain net-settlement
 *                  hop (master plan §3: corridor inventory in native
 *                  USDC, NOT USDsui — caps de-peg exposure)
 */

import { db, ensureSchema } from "@/lib/db";

// ───────────────────────────────────────────────────────────────────
// Types

/**
 * Directed corridor identifier, `SRC->DST` by ISO-3166 alpha-2 country.
 * The product launches ONE directed corridor (US->JP, master plan §6/§10);
 * the others are scaffolded so the ledger is corridor-agnostic from day
 * one. This is intentionally a free-form string at the DB layer so a
 * later corridor workstream can extend the set without a schema change;
 * the union below documents the planned set and gives call sites
 * autocomplete + a typo guard.
 */
export type Corridor =
  // African corridors (NGN partly live today)
  | "US->NG"
  | "US->KE"
  | "US->GH"
  | "US->ZA"
  // Asian / global corridors (US->JP is the beachhead)
  | "US->JP"
  | "US->SG"
  | "US->PH"
  | "US->ID"
  | "US->VN"
  // domestic / hub
  | "US->US"
  | "SG->PH"
  | "SG->ID"
  | "SG->VN";

/**
 * Currency code held in a pool. Superset of `fx.ts`'s display `Currency`
 * (which a separate FX workstream will widen to add JPY/SGD/PHP/IDR/VND);
 * kept as its own string union here so treasury doesn't import-couple to
 * the display-FX type and isn't broken by it changing underneath.
 */
export type PoolCurrency =
  | "USD"
  | "USDC"
  | "NGN"
  | "KES"
  | "GHS"
  | "ZAR"
  | "JPY"
  | "SGD"
  | "PHP"
  | "IDR"
  | "VND";

/**
 * Which side of the corridor a pool funds.
 *   • "funding" — the send leg (sender's collected fiat -> USDC)
 *   • "payout"  — the receive leg (USDC -> recipient's fiat)
 * A corridor has one pool per leg per currency.
 */
export type PoolLeg = "funding" | "payout";

/** One of the three inventory buckets a pool tracks. */
export type PoolBucket = "fiat_in" | "fiat_out" | "usdc";

/** Address of a single float pool. */
export interface PoolKey {
  corridor: Corridor;
  currency: PoolCurrency;
  leg: PoolLeg;
}

/** Current inventory snapshot of a float pool. */
export interface PoolState {
  corridor: Corridor;
  currency: PoolCurrency;
  leg: PoolLeg;
  /** Funding-leg fiat collected from senders. */
  fiatInPool: number;
  /** Payout-leg fiat pre-positioned for recipients. */
  fiatOutPool: number;
  /** Native USDC inventory for the on-chain net-settlement hop. */
  usdcPool: number;
  /**
   * True when this pool holds safeguarded CLIENT money. Safeguarded
   * balances are held in segregated client-money accounts and CANNOT be
   * lent into NAVI (master plan §5/§6/§9). False means Talise's own
   * operating float, which IS NAVI-eligible.
   */
  segregated: boolean;
  /** Wall-clock ms of the last reconciliation pass; null if never. */
  reconciledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Thresholds for `needsRebalance()`. All fields optional. */
export interface RebalanceThreshold {
  /**
   * Minimum payout-leg fiat inventory. A directed (diaspora-out) corridor
   * drains its payout pool and never refills it organically (master plan
   * §6), so this is the line that trips first.
   */
  minFiatOut?: number;
  /** Minimum USDC inventory for the net-settlement hop. */
  minUsdc?: number;
  /**
   * Max age (ms) since the last reconciliation before the pool is
   * considered stale and must be reconciled. A stale pool can't be
   * trusted for "instant" draw-down decisions.
   */
  maxReconcileAgeMs?: number;
}

/** Result of a `needsRebalance()` check. */
export interface RebalanceVerdict {
  needsRebalance: boolean;
  /** Machine-readable reasons, e.g. ["fiat_out_below_min", "stale"]. */
  reasons: string[];
}

// ───────────────────────────────────────────────────────────────────
// Internal helpers

const FLOAT_BUCKET_COLUMN: Record<PoolBucket, string> = {
  fiat_in: "fiat_in_pool",
  fiat_out: "fiat_out_pool",
  usdc: "usdc_pool",
};

function rowToState(row: Record<string, unknown>): PoolState {
  return {
    corridor: row.corridor as Corridor,
    currency: row.currency as PoolCurrency,
    leg: row.leg as PoolLeg,
    fiatInPool: Number(row.fiat_in_pool ?? 0),
    fiatOutPool: Number(row.fiat_out_pool ?? 0),
    usdcPool: Number(row.usdc_pool ?? 0),
    // postgres BOOLEAN comes back as a JS boolean; be defensive about
    // string/number encodings just in case the driver hands one over.
    segregated:
      row.segregated === true ||
      row.segregated === "t" ||
      row.segregated === "true" ||
      row.segregated === 1,
    reconciledAt:
      row.reconciled_at === null || row.reconciled_at === undefined
        ? null
        : Number(row.reconciled_at),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/**
 * Ensure a pool row exists for `key`, creating it (with the given
 * `segregated` flag) if absent. Idempotent — relies on the
 * `uniq_float_pools_key` index, so concurrent first-touches collapse to
 * one row. Returns the row's current state.
 */
async function ensurePool(
  key: PoolKey,
  segregated: boolean
): Promise<PoolState> {
  await ensureSchema();
  const c = db();
  const now = Date.now();
  // ON CONFLICT keeps this a single round-trip and concurrency-safe. The
  // segregated flag is only set on first insert — flipping it later is a
  // deliberate operation (see setSegregation), never a side effect of a
  // money movement.
  await c.execute({
    sql: `INSERT INTO float_pools
            (corridor, currency, leg, segregated, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (corridor, currency, leg) DO NOTHING`,
    args: [key.corridor, key.currency, key.leg, segregated, now, now],
  });
  const r = await c.execute({
    sql: `SELECT * FROM float_pools
          WHERE corridor = ? AND currency = ? AND leg = ? LIMIT 1`,
    args: [key.corridor, key.currency, key.leg],
  });
  return rowToState(r.rows[0] as Record<string, unknown>);
}

// ───────────────────────────────────────────────────────────────────
// Public API

/** Read one pool's current inventory, or null if it doesn't exist yet. */
export async function getPoolState(key: PoolKey): Promise<PoolState | null> {
  await ensureSchema();
  const r = await db().execute({
    sql: `SELECT * FROM float_pools
          WHERE corridor = ? AND currency = ? AND leg = ? LIMIT 1`,
    args: [key.corridor, key.currency, key.leg],
  });
  const row = r.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToState(row) : null;
}

/** List every pool, optionally filtered to one corridor. */
export async function listPools(corridor?: Corridor): Promise<PoolState[]> {
  await ensureSchema();
  const r = corridor
    ? await db().execute({
        sql: `SELECT * FROM float_pools WHERE corridor = ?
              ORDER BY currency, leg`,
        args: [corridor],
      })
    : await db().execute(
        `SELECT * FROM float_pools ORDER BY corridor, currency, leg`
      );
  return (r.rows as Array<Record<string, unknown>>).map(rowToState);
}

/**
 * Credit inventory into a pool bucket (positive `amount`). Creates the
 * pool on first touch. Used when fiat is collected on the funding leg,
 * when USDC is minted/bridged into inventory, or when a rebalance tops
 * up the payout leg.
 *
 * `segregated` declares whether THIS pool holds safeguarded client money.
 * It's applied only when the pool row is first created; for an existing
 * pool the stored flag wins (use `setSegregation` to change it
 * deliberately). Defaults to `true` (safeguard-by-default) — the safe
 * posture is to treat money as client money unless explicitly marked as
 * Talise's own operating float.
 */
export async function recordInflow(input: {
  key: PoolKey;
  bucket: PoolBucket;
  amount: number;
  segregated?: boolean;
}): Promise<PoolState> {
  const { key, bucket, amount } = input;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`recordInflow: amount must be a positive finite number, got ${amount}`);
  }
  await ensurePool(key, input.segregated ?? true);
  const col = FLOAT_BUCKET_COLUMN[bucket];
  const c = db();
  await c.execute({
    sql: `UPDATE float_pools
          SET ${col} = ${col} + ?, updated_at = ?
          WHERE corridor = ? AND currency = ? AND leg = ?`,
    args: [amount, Date.now(), key.corridor, key.currency, key.leg],
  });
  const state = await getPoolState(key);
  if (!state) throw new Error("recordInflow: pool vanished after update");
  return state;
}

/**
 * Debit inventory out of a pool bucket (positive `amount`). Used when
 * fiat is paid out on the payout leg, or USDC is settled out on the
 * net-settlement hop.
 *
 * Throws if the pool doesn't exist or the bucket would go negative —
 * you cannot pay out float you don't hold. This is a hard invariant: the
 * whole premise of "instant" is that the float was pre-positioned, so a
 * would-be-negative debit is a real treasury error, not a UX hiccup.
 */
export async function recordOutflow(input: {
  key: PoolKey;
  bucket: PoolBucket;
  amount: number;
}): Promise<PoolState> {
  const { key, bucket, amount } = input;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`recordOutflow: amount must be a positive finite number, got ${amount}`);
  }
  const existing = await getPoolState(key);
  if (!existing) {
    throw new Error(
      `recordOutflow: no pool for ${key.corridor}/${key.currency}/${key.leg}`
    );
  }
  const current =
    bucket === "fiat_in"
      ? existing.fiatInPool
      : bucket === "fiat_out"
        ? existing.fiatOutPool
        : existing.usdcPool;
  if (current - amount < 0) {
    throw new Error(
      `recordOutflow: insufficient ${bucket} inventory in ` +
        `${key.corridor}/${key.currency}/${key.leg}: ` +
        `have ${current}, requested ${amount}`
    );
  }
  const col = FLOAT_BUCKET_COLUMN[bucket];
  const c = db();
  await c.execute({
    sql: `UPDATE float_pools
          SET ${col} = ${col} - ?, updated_at = ?
          WHERE corridor = ? AND currency = ? AND leg = ?`,
    args: [amount, Date.now(), key.corridor, key.currency, key.leg],
  });
  const state = await getPoolState(key);
  if (!state) throw new Error("recordOutflow: pool vanished after update");
  return state;
}

/**
 * Mark a pool as reconciled now (or at `at` ms). Stamps `reconciled_at`,
 * which `needsRebalance()` reads for staleness. No money moves — this is
 * the "we've checked the books and they tie out" signal.
 */
export async function markReconciled(
  key: PoolKey,
  at: number = Date.now()
): Promise<PoolState> {
  const existing = await getPoolState(key);
  if (!existing) {
    throw new Error(
      `markReconciled: no pool for ${key.corridor}/${key.currency}/${key.leg}`
    );
  }
  await db().execute({
    sql: `UPDATE float_pools SET reconciled_at = ?, updated_at = ?
          WHERE corridor = ? AND currency = ? AND leg = ?`,
    args: [at, Date.now(), key.corridor, key.currency, key.leg],
  });
  const state = await getPoolState(key);
  if (!state) throw new Error("markReconciled: pool vanished after update");
  return state;
}

/**
 * Deliberately set whether a pool holds safeguarded client money. This
 * is an explicit treasury/compliance operation, never a side effect of a
 * money movement. Flipping `segregated` to false (making a pool's USDC
 * NAVI-eligible) must only ever apply to Talise's OWN operating float.
 */
export async function setSegregation(
  key: PoolKey,
  segregated: boolean
): Promise<PoolState> {
  const existing = await getPoolState(key);
  if (!existing) {
    throw new Error(
      `setSegregation: no pool for ${key.corridor}/${key.currency}/${key.leg}`
    );
  }
  await db().execute({
    sql: `UPDATE float_pools SET segregated = ?, updated_at = ?
          WHERE corridor = ? AND currency = ? AND leg = ?`,
    args: [segregated, Date.now(), key.corridor, key.currency, key.leg],
  });
  const state = await getPoolState(key);
  if (!state) throw new Error("setSegregation: pool vanished after update");
  return state;
}

/**
 * SAFEGUARDING INVARIANT (master plan §5/§6/§9): safeguarded client-money
 * balances CANNOT be lent into NAVI. Any code path that routes a pool's
 * USDC into NAVI (or any yield/lending venue) MUST call this first; it
 * throws if the pool is segregated, refusing to let client money be lent.
 *
 * This is deliberately a HARD STOP, not a warning — recharacterizing
 * safeguarded client money as a lendable asset is exactly the failure
 * mode that draws regulatory enforcement and (in a de-peg/run) loses
 * client funds. Only Talise's own operating float (segregated=false) may
 * pass.
 *
 * Pass either a `PoolKey` (looked up) or an already-loaded `PoolState`.
 * A missing pool also throws — you can't lend inventory that doesn't
 * exist, and silently treating "unknown" as "lendable" would defeat the
 * guard.
 */
export async function assertNotLendable(
  poolOrKey: PoolKey | PoolState
): Promise<void> {
  const state =
    "segregated" in poolOrKey
      ? poolOrKey
      : await getPoolState(poolOrKey);
  if (!state) {
    const k = poolOrKey as PoolKey;
    throw new Error(
      `assertNotLendable: no pool for ${k.corridor}/${k.currency}/${k.leg} — refusing to lend`
    );
  }
  if (state.segregated) {
    throw new Error(
      `assertNotLendable: pool ${state.corridor}/${state.currency}/${state.leg} ` +
        `holds safeguarded client money and CANNOT be lent into NAVI ` +
        `(master plan §5/§6/§9)`
    );
  }
}

/**
 * Whether a pool is under-funded or stale past the given thresholds and
 * therefore needs a rebalance pass (Circle redemption / local PSP top-up,
 * master plan §6). Pure read — never moves money.
 *
 * Directed diaspora-out corridors drain their PAYOUT leg and never refill
 * it organically, so `minFiatOut` is usually the first trip-wire. A pool
 * with no thresholds supplied can still trip on staleness if
 * `maxReconcileAgeMs` is given.
 */
export async function needsRebalance(
  key: PoolKey,
  threshold: RebalanceThreshold = {}
): Promise<RebalanceVerdict> {
  const state = await getPoolState(key);
  const reasons: string[] = [];
  if (!state) {
    return { needsRebalance: true, reasons: ["pool_missing"] };
  }
  if (
    threshold.minFiatOut !== undefined &&
    state.fiatOutPool < threshold.minFiatOut
  ) {
    reasons.push("fiat_out_below_min");
  }
  if (threshold.minUsdc !== undefined && state.usdcPool < threshold.minUsdc) {
    reasons.push("usdc_below_min");
  }
  if (threshold.maxReconcileAgeMs !== undefined) {
    if (state.reconciledAt === null) {
      reasons.push("never_reconciled");
    } else if (Date.now() - state.reconciledAt > threshold.maxReconcileAgeMs) {
      reasons.push("stale");
    }
  }
  return { needsRebalance: reasons.length > 0, reasons };
}
