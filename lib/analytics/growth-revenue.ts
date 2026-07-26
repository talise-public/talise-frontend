import "server-only";

import { db, ensureSchema, schemaVersionGate } from "@/lib/db";

/**
 * REVENUE MEASURABILITY.
 *
 * The gap: Talise charges real fees (swap spread, savings treasury cut, perp
 * close fee, FX spread on every corridor/cash-out) but NONE of them were ever
 * persisted. `transfers`, `tx_history` and `linq_offramps` have no `fee`
 * column, so "how much did we make last month" had no answer — not a hard
 * answer, not an approximate one.
 *
 * This module closes that in three additive, backward-compatible steps. It
 * does NOT change the semantics of any existing money table, and it does not
 * touch web/lib/db.ts.
 *
 *   1. ADDITIVE COLUMNS. `fee_usd` (and `fee_bps` on `transfers`) are added as
 *      NULLABLE columns via ALTER TABLE ADD COLUMN IF NOT EXISTS. Existing
 *      rows read as NULL, existing INSERTs keep working untouched, nothing
 *      reads them yet. Zero risk to a money path.
 *
 *   2. A CANONICAL LEDGER, `revenue_events`. Fees come from six different
 *      places with six different shapes; a single append-only ledger keyed by
 *      (source, ref) is what makes "revenue" one SUM instead of six. UNIQUE on
 *      (source, ref) makes every write idempotent, so a retried webhook or a
 *      replayed cron can never double-count.
 *
 *   3. DERIVATION for history. Because the fee schedule is deterministic
 *      (documented in `FEE_SCHEDULE`, mirroring the live constants), the fee on
 *      an ALREADY-SETTLED row can be recomputed from the row itself. So
 *      revenue is computable over the existing corpus, not just from today
 *      forward. `backfillTransferFees()` does exactly that, in bounded batches.
 *
 * Going forward, any money path can start recording its exact fee with one
 * non-blocking line:
 *
 *   recordRevenue({ source: "swap", ref: digest, userId, grossUsd, feeUsd });
 *
 * That call is fire-and-forget and individually guarded — it cannot throw into,
 * slow down, or fail the transaction it is measuring.
 */

// ── Schema ───────────────────────────────────────────────────────────────────

const REVENUE_SCHEMA_VERSION = "2026-07-25.1";

let _ready: Promise<void> | null = null;

export function ensureRevenueSchema(): Promise<void> {
  if (_ready) return _ready;
  _ready = (async () => {
    await ensureSchema();
    const c = db();

    const gate = await schemaVersionGate(
      "growth_revenue_schema_version",
      REVENUE_SCHEMA_VERSION
    );
    if (gate.upToDate) return;

    // ── 1. Additive fee columns on the existing money tables ────────────
    // Nullable, no default, never read by existing code. In Postgres 11+ this
    // is a METADATA-ONLY change (no table rewrite) — the minimum change that
    // makes per-row revenue attributable in the table that already owns the
    // row.
    //
    // BUT: ADD COLUMN still takes a brief ACCESS EXCLUSIVE lock, and these are
    // LIVE MONEY TABLES. If some long-running statement holds a conflicting
    // lock, our ALTER would queue — and while it queues it blocks every new
    // reader behind it, which would stall a send. So we run the ALTERs in one
    // transaction with `SET LOCAL lock_timeout`: if the lock isn't free almost
    // immediately we fail fast, leave the money path untouched, and the next
    // cold start retries (the version gate isn't stamped on failure).
    let feeColumnsAdded = true;
    try {
      await c.batch(
        [
          { sql: `SET LOCAL lock_timeout = '2s'`, args: [] },
          { sql: `ALTER TABLE transfers ADD COLUMN IF NOT EXISTS fee_usd DOUBLE PRECISION`, args: [] },
          { sql: `ALTER TABLE transfers ADD COLUMN IF NOT EXISTS fee_bps INTEGER`, args: [] },
          { sql: `ALTER TABLE tx_history ADD COLUMN IF NOT EXISTS fee_usd DOUBLE PRECISION`, args: [] },
          { sql: `ALTER TABLE linq_offramps ADD COLUMN IF NOT EXISTS fee_usd DOUBLE PRECISION`, args: [] },
        ],
        "write"
      );
    } catch (e) {
      // A lock timeout, or a table that doesn't exist yet on a fresh DB.
      // NON-FATAL: `revenue_events` below is what revenue is actually summed
      // from, so we still create it. We just don't stamp the version gate, so
      // the ALTERs retry on the next cold start.
      feeColumnsAdded = false;
      console.warn(`[revenue] fee-column migration deferred: ${(e as Error)?.message ?? e}`);
    }

    // ── 2. The canonical fee ledger ─────────────────────────────────────
    // `source` names the fee's origin, `ref` is that source's natural
    // identifier (tx digest, transfer id, off-ramp id). Together they are
    // UNIQUE, which is the whole idempotency story.
    //
    // `derived` marks a row computed from the fee schedule rather than
    // observed at charge time, so a dashboard can report "measured vs
    // derived" revenue honestly instead of blending them silently.
    await c.execute(
      `CREATE TABLE IF NOT EXISTS revenue_events (
        id         BIGSERIAL PRIMARY KEY,
        source     TEXT NOT NULL,
        ref        TEXT NOT NULL,
        user_id    INTEGER,
        gross_usd  DOUBLE PRECISION,
        fee_usd    DOUBLE PRECISION NOT NULL,
        fee_bps    INTEGER,
        currency   TEXT,
        corridor   TEXT,
        platform   TEXT,
        derived    BOOLEAN NOT NULL DEFAULT FALSE,
        occurred_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL
      )`
    );
    await c.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS revenue_events_source_ref_idx
         ON revenue_events (source, ref)`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS revenue_events_occurred_idx
         ON revenue_events (occurred_at DESC)`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS revenue_events_source_idx
         ON revenue_events (source, occurred_at DESC)`
    );

    // Stamp only when EVERYTHING landed. A deferred fee-column migration has to
    // be retried, and the gate is exactly what would skip it.
    if (feeColumnsAdded) await gate.stamp();
  })().catch((err) => {
    _ready = null;
    throw err;
  });
  return _ready;
}

// ── The fee schedule ─────────────────────────────────────────────────────────

/**
 * Where Talise's money comes from, in basis points.
 *
 * MIRRORS the live constants — this table is documentation AND the input to
 * historical derivation, so it must track its sources:
 *   • swapNonStable   → SWAP_FEE_BPS,            web/app/api/swap/prepare/route.ts
 *   • earnSupply      → SAVE_TREASURY_FEE_BPS,   web/lib/navi-supply.ts
 *   • perpClose       → PERP_CLOSE_FEE_BPS env,  web/lib/waterx.ts
 *   • fxSpreadFloor   → TIER_SPREAD_BPS/corridor spreadBps, web/lib/fx-feed.ts
 *                       + web/lib/corridors.ts (registry floor per corridor)
 *
 * Stablecoin↔stablecoin swaps are free (0 bps) and card funding fees are a
 * pass-through of the processor's cost, NOT Talise margin, so neither is
 * revenue and neither appears here.
 */
export const FEE_SCHEDULE = {
  swapNonStableBps: 100, // 1.00%
  swapStableBps: 0,
  earnSupplyBps: 100, // 1.00% of the supplied principal
  perpCloseBps: Number(process.env.PERP_CLOSE_FEE_BPS) || 200, // 2.00%
  /** Conservative floor used when a corridor's own spread isn't recoverable. */
  fxSpreadFloorBps: 35,
} as const;

/** Fee origins the ledger understands. */
export type RevenueSource =
  | "swap"
  | "earn_supply"
  | "perp_close"
  | "fx_spread"
  | "offramp"
  | "onramp"
  | "send";

// ── Recording (the one-liner for money paths) ────────────────────────────────

export type RecordRevenueInput = {
  source: RevenueSource;
  /** Natural id from the source system (tx digest, transfer id, off-ramp id). */
  ref: string;
  userId?: number | null;
  /** Notional the fee was taken on, in USD. */
  grossUsd?: number | null;
  /** Talise's fee, in USD. The number that IS revenue. */
  feeUsd: number;
  feeBps?: number | null;
  currency?: string | null;
  corridor?: string | null;
  platform?: string | null;
  /** Epoch ms the fee was actually charged. Defaults to now. */
  occurredAt?: number;
  /** True when computed from FEE_SCHEDULE rather than observed. */
  derived?: boolean;
};

/**
 * Append a fee to the ledger. Fire-and-forget: returns a promise you may
 * ignore, and it swallows its own errors. Safe to call from inside a money path
 * because it can neither throw nor block the caller's result.
 *
 * Idempotent on (source, ref) — call it twice for the same digest and the
 * second call is a no-op, which is exactly what a retried webhook needs.
 */
export async function recordRevenue(input: RecordRevenueInput): Promise<void> {
  try {
    const fee = Number(input.feeUsd);
    if (!Number.isFinite(fee) || fee <= 0) return;
    if (!input.ref) return;
    const now = Date.now();
    await ensureRevenueSchema();
    await db().execute({
      sql: `INSERT INTO revenue_events
              (source, ref, user_id, gross_usd, fee_usd, fee_bps, currency,
               corridor, platform, derived, occurred_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (source, ref) DO NOTHING`,
      args: [
        input.source,
        input.ref,
        input.userId ?? null,
        input.grossUsd ?? null,
        fee,
        input.feeBps ?? null,
        input.currency ?? null,
        input.corridor ?? null,
        input.platform ?? null,
        input.derived ?? false,
        input.occurredAt ?? now,
        now,
      ],
    });
  } catch (e) {
    console.warn(`[revenue] record failed: ${(e as Error)?.message ?? e}`);
  }
}

// ── Derivation ───────────────────────────────────────────────────────────────

/**
 * Talise's FX-spread revenue on one settled transfer.
 *
 * A cross-border transfer's margin is the spread between the mid-market rate
 * and the rate we quoted. We don't store the mid rate on the row, but the
 * quoted rate together with the corridor's documented spread reconstructs it:
 *
 *   quoted = mid × (1 − spread)  ⇒  mid = quoted / (1 − spread)
 *   revenue_usd ≈ usdsui_amount × spread
 *
 * We use the corridor's registered spread when the row carries one in its
 * metadata, else the conservative tier floor. The result is explicitly marked
 * `derived: true` in the ledger — it is an estimate from a published schedule,
 * and a dashboard must be able to say so.
 */
export function deriveTransferFeeUsd(row: {
  usdsui_amount?: unknown;
  metadata?: unknown;
  source_currency?: unknown;
  dest_currency?: unknown;
}): { feeUsd: number; feeBps: number } | null {
  const gross = Number(row.usdsui_amount);
  if (!Number.isFinite(gross) || gross <= 0) return null;

  const from = String(row.source_currency ?? "");
  const to = String(row.dest_currency ?? "");
  // Same-currency movement (e.g. USD→USD internal) carries no FX spread.
  if (!from || !to || from === to) return null;

  let bps: number = FEE_SCHEDULE.fxSpreadFloorBps;
  try {
    const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
    const fromMeta = Number((meta as Record<string, unknown> | null)?.spreadBps);
    if (Number.isFinite(fromMeta) && fromMeta > 0 && fromMeta < 2_000) bps = fromMeta;
  } catch {
    /* metadata isn't JSON on some legacy rows — fall through to the floor */
  }

  return { feeUsd: (gross * bps) / 10_000, feeBps: bps };
}

/**
 * Backfill `transfers.fee_usd` (and the ledger) for settled rows that don't
 * have it yet, oldest first, in a bounded batch.
 *
 * Only ever writes the NEW nullable column — it never touches an existing
 * column, so it cannot change how a transfer behaves. Intended to be driven by
 * a cron or an admin action; nothing calls it automatically.
 *
 * Returns how many rows it filled, so a caller can loop until it returns 0.
 */
export async function backfillTransferFees(limit = 200): Promise<number> {
  await ensureRevenueSchema();
  const c = db();
  const batch = Math.max(1, Math.min(1_000, Math.floor(limit)));

  const r = await c.execute({
    sql: `SELECT id, user_id, usdsui_amount, source_currency, dest_currency,
                 metadata, settled_at, created_at
            FROM transfers
           WHERE fee_usd IS NULL
             AND state = 'settled'
           ORDER BY created_at ASC
           LIMIT ?`,
    args: [batch],
  });

  let filled = 0;
  for (const raw of r.rows) {
    const row = raw as Record<string, unknown>;
    const derived = deriveTransferFeeUsd(row);
    if (!derived) continue;
    const id = String(row.id);
    await c
      .execute({
        sql: `UPDATE transfers SET fee_usd = ?, fee_bps = ? WHERE id = ? AND fee_usd IS NULL`,
        args: [derived.feeUsd, derived.feeBps, id],
      })
      .catch(() => undefined);
    await recordRevenue({
      source: "fx_spread",
      ref: id,
      userId: row.user_id == null ? null : Number(row.user_id),
      grossUsd: Number(row.usdsui_amount),
      feeUsd: derived.feeUsd,
      feeBps: derived.feeBps,
      corridor: `${String(row.source_currency ?? "")}->${String(row.dest_currency ?? "")}`,
      occurredAt: Number(row.settled_at ?? row.created_at) || Date.now(),
      derived: true,
    });
    filled++;
  }
  return filled;
}

// ── Read side ────────────────────────────────────────────────────────────────

export type RevenueTotals = {
  source: string;
  feeUsd: number;
  grossUsd: number;
  n: number;
  derived: boolean;
};

/**
 * Revenue by source over a window. One query, one round-trip — the prod pool
 * is small, so the dashboard aggregates in Postgres and never pulls rows.
 */
export async function revenueBySource(sinceMs: number): Promise<RevenueTotals[]> {
  await ensureRevenueSchema();
  const r = await db().execute({
    sql: `SELECT source,
                 derived,
                 COALESCE(SUM(fee_usd), 0)   AS fee_usd,
                 COALESCE(SUM(gross_usd), 0) AS gross_usd,
                 COUNT(*)                    AS n
            FROM revenue_events
           WHERE occurred_at >= ?
           GROUP BY source, derived
           ORDER BY fee_usd DESC`,
    args: [sinceMs],
  });
  return r.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      source: String(row.source),
      derived: row.derived === true || row.derived === "t",
      feeUsd: Number(row.fee_usd) || 0,
      grossUsd: Number(row.gross_usd) || 0,
      n: Number(row.n) || 0,
    };
  });
}
