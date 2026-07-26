import "server-only";

import { db } from "@/lib/db";

import { settleAttempt } from "./store";

/**
 * MONOTONIC payout-status writes.
 *
 * THE BUG THIS FIXES
 * ------------------
 * Both the Linq webhook and the Linq status poll wrote the provider's status
 * string straight into `linq_offramps` with an unconditional UPDATE:
 *
 *     UPDATE linq_offramps SET status = ? WHERE linq_order_id = ?
 *
 * Webhooks are replayed and can arrive out of order, and the poll races the
 * webhook. So a late/duplicated `order.processing` event could overwrite a
 * `disbursed` order and walk a SETTLED payout back to "in progress" — the app
 * then shows a completed cash-out as pending, support can't tell a stuck payout
 * from a finished one, and a reconciliation pass could re-act on it.
 *
 * Terminal states are now STICKY, with exactly one deliberate exception:
 * `failed → completed` is allowed, because if the money really did land we must
 * never keep telling the user it failed. `completed → failed` is refused.
 */

/** Coarse lifecycle phase, provider-agnostic. */
export type PayoutPhase = "initiated" | "processing" | "completed" | "failed";

const TERMINAL_PHASES: ReadonlySet<PayoutPhase> = new Set<PayoutPhase>([
  "completed",
  "failed",
]);

/**
 * Map a provider's free-text status to a phase.
 *
 * NOTE on "timeout": Linq uses it for a lagging bank payout, not a dead one, so
 * it maps to `processing` and stays pollable. That is why an un-funded expired
 * order has to be closed out by the reconciler (see `reconcile.ts`) rather than
 * inferred from provider text.
 */
export function phaseOf(status: string | null | undefined): PayoutPhase {
  const s = (status ?? "").toLowerCase();
  if (
    s.includes("disbursed") ||
    s.includes("settled") ||
    s.includes("completed") ||
    s.includes("success") ||
    s.includes("paid")
  ) {
    return "completed";
  }
  if (
    s.includes("failed") ||
    s.includes("reject") ||
    s.includes("cancel") ||
    s.includes("expired") ||
    s.includes("returned") ||
    s.includes("refunded")
  ) {
    return "failed";
  }
  if (
    s.includes("processing") ||
    s.includes("queue") ||
    s.includes("worker") ||
    s.includes("timeout") ||
    s.includes("pending") ||
    s.includes("in_progress")
  ) {
    return "processing";
  }
  return "initiated";
}

export function isTerminalPhase(p: PayoutPhase): boolean {
  return TERMINAL_PHASES.has(p);
}

/** Whether `from → to` is a legal phase move under the monotonic rule. */
export function phaseAdvanceAllowed(from: PayoutPhase, to: PayoutPhase): boolean {
  if (from === to) return false; // no-op, nothing to write
  if (from === "completed") return false; // success is final, always
  if (from === "failed") return to === "completed"; // money actually landed
  return true; // initiated/processing may move anywhere
}

export interface StatusWriteResult {
  applied: boolean;
  fromPhase: PayoutPhase;
  toPhase: PayoutPhase;
  reason?: string;
}

/**
 * Apply a provider status to a `linq_offramps` row, monotonically.
 *
 * The UPDATE re-checks the observed status in its WHERE clause, so two racing
 * writers (webhook + poll) cannot both apply: the loser sees `rowsAffected === 0`
 * and is reported as not-applied rather than silently clobbering.
 *
 * Also mirrors the outcome into the cross-rail attempt ledger, flagging a
 * FUNDED-but-failed payout as owing a refund. That flag is the whole point: the
 * "provider 500s with no auto-refund" incident produced users who were out the
 * money with nothing in the system saying so.
 */
export async function applyLinqStatus(input: {
  /** Linq's order id (the provider reference). */
  linqOrderId: string;
  /** The provider's status text for this event/poll. */
  status: string;
  /** Where the update came from, for the audit log. */
  source: "webhook" | "poll" | "reconcile";
  reason?: string;
}): Promise<StatusWriteResult> {
  const c = db();
  const cur = await c.execute({
    sql: `SELECT status FROM linq_offramps WHERE linq_order_id = ? LIMIT 1`,
    args: [input.linqOrderId],
  });
  const currentStatus = (cur.rows[0]?.status as string | undefined) ?? null;
  if (currentStatus == null) {
    return { applied: false, fromPhase: "initiated", toPhase: phaseOf(input.status), reason: "row not found" };
  }

  const fromPhase = phaseOf(currentStatus);
  const toPhase = phaseOf(input.status);

  if (currentStatus === input.status) {
    return { applied: false, fromPhase, toPhase, reason: "unchanged" };
  }
  if (!phaseAdvanceAllowed(fromPhase, toPhase)) {
    console.warn(
      `[offramp/status] refused ${fromPhase} → ${toPhase} for order=${input.linqOrderId} ` +
        `(source=${input.source}, incoming="${input.status}"): terminal states are sticky`
    );
    return { applied: false, fromPhase, toPhase, reason: "non-monotonic" };
  }

  const upd = await c.execute({
    sql: `UPDATE linq_offramps
             SET status = ?, status_reason = COALESCE(?, status_reason), updated_at = ?
           WHERE linq_order_id = ? AND status = ?`,
    args: [
      input.status,
      input.reason ? `${input.source}: ${input.reason}`.slice(0, 500) : null,
      Date.now(),
      input.linqOrderId,
      currentStatus,
    ],
  });
  if ((upd.rowsAffected ?? 0) === 0) {
    return { applied: false, fromPhase, toPhase, reason: "raced" };
  }

  // Mirror into the cross-rail ledger. Best-effort: the customer-visible state
  // lives in `linq_offramps`, this is the reconciliation/refund view.
  if (isTerminalPhase(toPhase)) {
    try {
      await settleAttempt({
        provider: "linq",
        providerRef: input.linqOrderId,
        state: toPhase === "completed" ? "settled" : "failed",
        terminal: true,
        // A FUNDED attempt that failed owes the user a refund. `settleAttempt`
        // only raises the flag when the attempt is actually funded, so an order
        // that expired without a deposit does not create phantom refund work.
        needsRefund: toPhase === "failed",
        reason: input.reason ?? `${input.source}: ${input.status}`,
      });
    } catch (e) {
      console.warn("[offramp/status] attempt-ledger mirror failed:", (e as Error).message);
    }
  }

  console.log(
    `[offramp/status] order=${input.linqOrderId} ${fromPhase} → ${toPhase} ("${input.status}", source=${input.source})`
  );
  return { applied: true, fromPhase, toPhase };
}
