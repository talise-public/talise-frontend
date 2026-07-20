import "server-only";

import { randomUUID } from "node:crypto";

import { db, ensureSchema } from "@/lib/db";

/**
 * Corridor-agnostic transfers state machine.
 *
 * A single machine that drives ANY corridor, African (NGN/KES/GHS/ZAR) and
 * Asian/global (JPY/SGD/PHP/IDR/VND/USD), through one typed lifecycle. See
 * the master plan §3 (line 62) and §11 item 5:
 *
 *   quoted → debited → onchain_settling → onchain_settled
 *          → fiat_out_pending → settled   (+ failed / refunded)
 *
 * THE COMMIT POINT is the on-chain leg. Until `onchain_settled` the transfer
 * can be cleanly aborted (no value has crossed Talise's trust boundary). Once
 * the chain has moved value, we are committed: a downstream fiat-out failure
 * does NOT lose funds, it PARKS them (`failed` with `parkedFunds=true`) so a
 * compensating action (refund to sender, credit to recipient vault, manual
 * retry) can reconcile later. This is the "compensating-failure" semantics the
 * master plan calls for ("fiat-out failure parks funds in the recipient's
 * vault, never lost").
 *
 * The live NGN off-ramp is the Linq engine (web/lib/linq.ts +
 * web/app/api/offramp/linq/*), tracked in its own `linq_offramps` table.
 *
 * No HTTP/provider I/O lives here, only the persisted state + the legal
 * transitions. Callers (corridor routes) drive the machine by firing events
 * and supply the side effects (FX quote, chain verification, PSP payout).
 */

// ─── States ──────────────────────────────────────────────────────────

/**
 * Lifecycle states. Ordered roughly by progression; `failed`/`refunded` are
 * terminal off-ramps reachable from several points.
 */
export type TransferState =
  | "quoted"            // TTL-locked FX quote persisted; nothing debited yet.
  | "debited"           // Sender's funds debited (fiat collection OR on-chain send observed pending).
  | "onchain_settling"  // On-chain USDC/USDsui leg broadcast, awaiting finality.
  | "onchain_settled"   // ◀── COMMIT POINT. Chain leg final; value crossed the boundary.
  | "fiat_out_pending"  // Destination fiat payout submitted to the PSP, awaiting settlement.
  | "settled"           // Recipient paid out in destination fiat. Terminal (success).
  | "failed"            // Terminal failure. If reached post-commit, `parkedFunds=true`.
  | "refunded";         // Terminal: funds returned to sender (pre-commit abort or reconciled park).

/** States from which no transition is legal. */
export const TERMINAL_STATES: ReadonlySet<TransferState> = new Set<TransferState>([
  "settled",
  "failed",
  "refunded",
]);

/**
 * The commit point. At/after this state a `fail` does not unwind value, it
 * parks the funds for compensating reconciliation. Before it, `fail`/`abort`
 * is clean (nothing committed).
 */
export const COMMIT_STATE: TransferState = "onchain_settled";

const STATE_ORDER: Record<TransferState, number> = {
  quoted: 0,
  debited: 1,
  onchain_settling: 2,
  onchain_settled: 3,
  fiat_out_pending: 4,
  settled: 5,
  failed: 6,
  refunded: 7,
};

/** True once the transfer has passed (or reached) the on-chain commit point. */
export function isPastCommit(state: TransferState): boolean {
  return STATE_ORDER[state] >= STATE_ORDER[COMMIT_STATE] && !TERMINAL_STATES.has(state);
}

// ─── Events ──────────────────────────────────────────────────────────

/**
 * Events that drive the machine. The happy path is a linear walk
 * (`debit → start_onchain → confirm_onchain → start_fiat_out → confirm_fiat_out`);
 * `fail`, `abort`, and `refund` are the failure/compensation edges.
 */
export type TransferEvent =
  | "debit"             // quoted → debited
  | "start_onchain"     // debited → onchain_settling
  | "confirm_onchain"   // onchain_settling → onchain_settled  (crosses commit)
  | "start_fiat_out"    // onchain_settled → fiat_out_pending
  | "confirm_fiat_out"  // fiat_out_pending → settled
  | "fail"              // → failed (parks funds if post-commit)
  | "abort"             // pre-commit clean cancel → failed (no parked funds)
  | "refund";           // → refunded (sender made whole)

// ─── Transition table ────────────────────────────────────────────────

/**
 * Allowed `from → event → to`. Anything not listed is rejected by
 * `advanceTransfer`. `fail`/`abort`/`refund` are deliberately broad because
 * a corridor can stall at many points; the guard logic in `advanceTransfer`
 * enforces the commit-point semantics on top of this table.
 */
const TRANSITIONS: ReadonlyArray<{
  from: TransferState;
  event: TransferEvent;
  to: TransferState;
}> = [
  // Happy path.
  { from: "quoted", event: "debit", to: "debited" },
  { from: "debited", event: "start_onchain", to: "onchain_settling" },
  { from: "onchain_settling", event: "confirm_onchain", to: "onchain_settled" },
  { from: "onchain_settled", event: "start_fiat_out", to: "fiat_out_pending" },
  { from: "fiat_out_pending", event: "confirm_fiat_out", to: "settled" },

  // Pre-commit abort (clean, nothing has crossed the boundary).
  { from: "quoted", event: "abort", to: "failed" },
  { from: "debited", event: "abort", to: "failed" },
  { from: "onchain_settling", event: "abort", to: "failed" },

  // Failures. Pre-commit failures behave like aborts (no parked funds);
  // post-commit failures park the funds (enforced in advanceTransfer).
  { from: "quoted", event: "fail", to: "failed" },
  { from: "debited", event: "fail", to: "failed" },
  { from: "onchain_settling", event: "fail", to: "failed" },
  { from: "onchain_settled", event: "fail", to: "failed" },
  { from: "fiat_out_pending", event: "fail", to: "failed" },

  // Refunds, sender made whole. Pre-commit: trivially (funds never left).
  // Post-commit / from a parked `failed`: requires an explicit on-chain or
  // ledger compensating action by the caller before firing this.
  { from: "quoted", event: "refund", to: "refunded" },
  { from: "debited", event: "refund", to: "refunded" },
  { from: "onchain_settling", event: "refund", to: "refunded" },
  { from: "onchain_settled", event: "refund", to: "refunded" },
  { from: "fiat_out_pending", event: "refund", to: "refunded" },
  // A parked failure can be reconciled into a refund once compensated.
  { from: "failed", event: "refund", to: "refunded" },
];

function lookupTransition(
  from: TransferState,
  event: TransferEvent
): TransferState | null {
  const t = TRANSITIONS.find((x) => x.from === from && x.event === event);
  return t ? t.to : null;
}

/** Events legal from `state` right now (useful for UI/debugging). */
export function allowedEvents(state: TransferState): TransferEvent[] {
  return TRANSITIONS.filter((t) => t.from === state).map((t) => t.event);
}

// ─── Domain types ────────────────────────────────────────────────────

/**
 * A transfer direction.
 *  - `offramp`  : USDsui/USDC → destination fiat (e.g. the Linq NGN payout).
 *  - `onramp`   : source fiat → USDsui/USDC.
 *  - `cross_border` : source fiat → (on-chain net-settle) → destination fiat,
 *    the JP→US flow from §3.
 *  - `internal` : Talise→Talise ledger transfer; on-chain leg may be a no-op
 *    but the machine still tracks it uniformly.
 */
export type TransferKind = "offramp" | "onramp" | "cross_border" | "internal";

export interface CreateTransferInput {
  userId: string | number;
  kind: TransferKind;
  /** PSP / rail provider key, e.g. "linq" | "stripe" | "circle" | "jpyc". */
  provider: string;
  /** Source corridor currency (what the sender funds in), e.g. "USD", "JPY". */
  sourceCurrency: string;
  /** Destination corridor currency (what the recipient receives), e.g. "NGN". */
  destCurrency: string;
  /** USDsui amount that crosses the on-chain leg (6dp), the on-chain truth. */
  usdsuiAmount: number;
  /** Amount the sender is debited, in `sourceCurrency` minor-agnostic units. */
  sourceAmount: number;
  /** Amount the recipient receives, in `destCurrency`. */
  destAmount: number;
  /** Locked FX (units of destCurrency per 1 USD), captured at quote time. */
  fxRate: number;
  /** Opaque per-corridor metadata (bank coords, handle, memo). Stored as JSON. */
  metadata?: Record<string, unknown>;
  /** Optional explicit id; defaults to a fresh uuid. */
  id?: string;
}

export interface TransferRecord {
  id: string;
  userId: string;
  kind: TransferKind;
  provider: string;
  state: TransferState;
  sourceCurrency: string;
  destCurrency: string;
  usdsuiAmount: number;
  sourceAmount: number;
  destAmount: number;
  fxRate: number;
  /** On-chain digest of the committed leg, once `confirm_onchain` lands. */
  onchainDigest: string | null;
  /** PSP reference for the fiat-out leg, once submitted. */
  providerReference: string | null;
  /** Free-text reason for the latest failure/abort/refund. */
  stateReason: string | null;
  /**
   * True iff funds are PARKED, i.e. value crossed the on-chain commit point
   * and a downstream leg failed. These funds are NOT lost; they await a
   * compensating action (refund to sender / credit to recipient vault).
   */
  parkedFunds: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  debitedAt: number | null;
  onchainSettledAt: number | null;
  settledAt: number | null;
  failedAt: number | null;
}

export interface AdvanceContext {
  /** Set on `confirm_onchain`, the digest of the committed on-chain leg. */
  onchainDigest?: string;
  /** Set on `start_fiat_out`, the PSP reference for the payout. */
  providerReference?: string;
  /** Human-readable reason; required (advisory) for fail/abort/refund. */
  reason?: string;
  /** Merge into the stored metadata blob. */
  metadata?: Record<string, unknown>;
}

export type AdvanceResult =
  | { ok: true; transfer: TransferRecord }
  | {
      ok: false;
      /** "not_found" | "illegal_transition" | "terminal" | "conflict". */
      code: "not_found" | "illegal_transition" | "terminal" | "conflict";
      message: string;
      /** Present when the transfer exists; its current (unchanged) state. */
      current?: TransferRecord;
    };

// ─── Row mapping ─────────────────────────────────────────────────────

interface TransferRow {
  id: string;
  user_id: string;
  kind: string;
  provider: string;
  state: string;
  source_currency: string;
  dest_currency: string;
  usdsui_amount: string | number;
  source_amount: string | number;
  dest_amount: string | number;
  fx_rate: string | number;
  onchain_digest: string | null;
  provider_reference: string | null;
  state_reason: string | null;
  parked_funds: boolean | number | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
  debited_at: number | null;
  onchain_settled_at: number | null;
  settled_at: number | null;
  failed_at: number | null;
}

function toNumber(v: string | number | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  return 0;
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mapRow(row: TransferRow): TransferRecord {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as TransferKind,
    provider: row.provider,
    state: row.state as TransferState,
    sourceCurrency: row.source_currency,
    destCurrency: row.dest_currency,
    usdsuiAmount: toNumber(row.usdsui_amount),
    sourceAmount: toNumber(row.source_amount),
    destAmount: toNumber(row.dest_amount),
    fxRate: toNumber(row.fx_rate),
    onchainDigest: row.onchain_digest,
    providerReference: row.provider_reference,
    stateReason: row.state_reason,
    parkedFunds: row.parked_funds === true || row.parked_funds === 1,
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    debitedAt: row.debited_at,
    onchainSettledAt: row.onchain_settled_at,
    settledAt: row.settled_at,
    failedAt: row.failed_at,
  };
}

// ─── API ─────────────────────────────────────────────────────────────

/**
 * Create a new transfer in the `quoted` state. The caller has already priced
 * the FX quote and resolved the recipient; this persists the locked quote so
 * `advanceTransfer` can drive it. Returns the freshly-created record.
 */
export async function createTransfer(
  input: CreateTransferInput
): Promise<TransferRecord> {
  await ensureSchema();
  const id = input.id ?? randomUUID();
  const now = Date.now();
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

  await db().execute({
    sql: `INSERT INTO transfers
      (id, user_id, kind, provider, state,
       source_currency, dest_currency,
       usdsui_amount, source_amount, dest_amount, fx_rate,
       metadata, parked_funds, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'quoted', ?, ?, ?, ?, ?, ?, ?, FALSE, ?, ?)`,
    args: [
      id,
      String(input.userId),
      input.kind,
      input.provider,
      input.sourceCurrency,
      input.destCurrency,
      input.usdsuiAmount,
      input.sourceAmount,
      input.destAmount,
      input.fxRate,
      metadataJson,
      now,
      now,
    ],
  });

  const created = await getTransfer(id);
  if (!created) {
    // Should be impossible directly after a successful insert.
    throw new Error(`transfers: created row ${id} not readable`);
  }
  return created;
}

/** Read a transfer by id, or null if it does not exist. */
export async function getTransfer(id: string): Promise<TransferRecord | null> {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT * FROM transfers WHERE id = ? LIMIT 1",
    args: [id],
  });
  const row = r.rows[0] as unknown as TransferRow | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Fire `event` against transfer `id`, applying the transition guards and the
 * compensating-failure semantics.
 *
 * Concurrency: the UPDATE is guarded by `WHERE id=? AND state=?` so two racing
 * callers can't both advance the same transfer, the loser sees `rowsAffected
 * === 0` and gets a `conflict` result (the row moved underneath it).
 *
 * Commit-point semantics:
 *  - A `fail` at/after `onchain_settled` PARKS the funds (`parkedFunds=true`):
 *    the on-chain value is committed and irreversible, so we record the
 *    failure WITHOUT pretending the money vanished. A compensating action
 *    (refund / recipient-vault credit) reconciles it later.
 *  - A `fail`/`abort` BEFORE the commit point leaves `parkedFunds=false`: no
 *    value crossed the boundary, nothing to reconcile.
 */
export async function advanceTransfer(
  id: string,
  event: TransferEvent,
  ctx: AdvanceContext = {}
): Promise<AdvanceResult> {
  await ensureSchema();
  const c = db();

  const current = await getTransfer(id);
  if (!current) {
    return { ok: false, code: "not_found", message: `transfer ${id} not found` };
  }
  // Terminal states block forward progress, with ONE deliberate carve-out:
  // a parked `failed` transfer may be reconciled into a `refunded` once the
  // caller has performed the compensating action (the table defines
  // failed→refund explicitly). Without this exception the post-commit
  // "park funds for later reconciliation" guarantee is dead code, you
  // could never actually refund a parked failure.
  const isReconcileRefund = current.state === "failed" && event === "refund";
  if (TERMINAL_STATES.has(current.state) && !isReconcileRefund) {
    return {
      ok: false,
      code: "terminal",
      message: `transfer ${id} is terminal (${current.state}); cannot fire '${event}'`,
      current,
    };
  }

  const to = lookupTransition(current.state, event);
  if (!to) {
    return {
      ok: false,
      code: "illegal_transition",
      message: `no '${event}' transition from '${current.state}'`,
      current,
    };
  }

  const now = Date.now();

  // Compensating-failure: parking only happens when a failure lands AFTER the
  // on-chain commit point. A clean pre-commit fail/abort, or any non-failure
  // transition, preserves the existing parked flag (normally false).
  const isFailureEvent = event === "fail" || event === "abort";
  const willPark = isFailureEvent && isPastCommit(current.state);

  // Build the SET clause incrementally so each event only touches its columns.
  const sets: string[] = ["state = ?", "updated_at = ?"];
  const args: unknown[] = [to, now];

  if (ctx.reason !== undefined) {
    sets.push("state_reason = ?");
    args.push(ctx.reason.slice(0, 500));
  }
  if (ctx.onchainDigest !== undefined) {
    sets.push("onchain_digest = ?");
    args.push(ctx.onchainDigest);
  }
  if (ctx.providerReference !== undefined) {
    sets.push("provider_reference = ?");
    args.push(ctx.providerReference);
  }
  if (ctx.metadata !== undefined) {
    const merged = { ...(current.metadata ?? {}), ...ctx.metadata };
    sets.push("metadata = ?");
    args.push(JSON.stringify(merged));
  }

  // Stamp lifecycle timestamps as we cross each milestone.
  if (event === "debit") {
    sets.push("debited_at = ?");
    args.push(now);
  }
  if (event === "confirm_onchain") {
    sets.push("onchain_settled_at = ?");
    args.push(now);
  }
  if (to === "settled") {
    sets.push("settled_at = ?");
    args.push(now);
  }
  if (to === "failed") {
    sets.push("failed_at = ?");
    args.push(now);
    // Only flip parked_funds to TRUE on a post-commit failure; never silently
    // clear an already-parked flag.
    if (willPark) {
      sets.push("parked_funds = TRUE");
    }
  }

  // Optimistic-concurrency guard: only advance if still in the observed state.
  args.push(id, current.state);
  const upd = await c.execute({
    sql: `UPDATE transfers SET ${sets.join(", ")} WHERE id = ? AND state = ?`,
    args,
  });

  if (upd.rowsAffected === 0) {
    // Someone moved the row between our read and our write.
    const latest = await getTransfer(id);
    return {
      ok: false,
      code: "conflict",
      message: `transfer ${id} changed concurrently; '${event}' not applied`,
      current: latest ?? current,
    };
  }

  const updated = await getTransfer(id);
  if (!updated) {
    throw new Error(`transfers: row ${id} vanished after update`);
  }
  return { ok: true, transfer: updated };
}

// ─── Linq off-ramp mapping (documentation, not executed) ─────────────

/**
 * How the Linq off-ramp order states (web/app/api/offramp/linq/) project onto
 * this machine. The Linq routes own `linq_offramps` and Linq itself owns
 * deposit detection / timeout / payout, so there's no treasury or refund leg.
 * This is the mapping to follow when/if a corridor route is re-pointed at
 * `transfers`:
 *
 *   Linq phase   →  transfers state
 *   ──────────────────────────────────────────────
 *   initiated    →  quoted / onchain_settling   (order created; awaiting deposit)
 *   processing   →  fiat_out_pending            (deposit seen; paying the bank)
 *   completed    →  settled                     (NGN disbursed)
 *   failed       →  failed                      (timeout / reject)
 */
export const LINQ_STATE_MAP: Readonly<Record<string, TransferState>> = {
  initiated: "onchain_settling",
  processing: "fiat_out_pending",
  completed: "settled",
  failed: "failed",
};
