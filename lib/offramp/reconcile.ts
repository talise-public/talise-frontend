import "server-only";

import { db, ensureSchema } from "@/lib/db";
import { getOrderStatus, linqConfigured } from "@/lib/linq";

import { isProviderSideFailure, reportProviderOutcome } from "./breaker";
import { DEPOSIT_WINDOW_SLACK_MS, strandedAfterMs } from "./config";
import { applyLinqStatus, isTerminalPhase, phaseOf } from "./status";
import {
  ensureOfframpProviderSchema,
  listRefundsOwed,
  settleAttempt,
} from "./store";

/**
 * TERMINAL-STATE RECONCILIATION for the fiat-out path.
 *
 * WHAT WAS MISSING
 * ----------------
 * Before this, a payout row only ever changed state because (a) the provider's
 * webhook arrived, or (b) the user's app happened to poll it. Both are optional:
 *
 *   • Webhooks get lost, and Linq's delivery is best-effort with no replay tool.
 *   • Polling stops the moment the user closes the app.
 *
 * So an order could sit at `initiated` forever. Three consequences, all real:
 *
 *   1. INVISIBLE STRANDING. A user who funded an order that then failed at the
 *      provider had nothing anywhere in the system saying "this person is out
 *      their money". That is precisely the shape of the known incident: the
 *      provider 500-ed, did not auto-refund, and nobody knew until users
 *      complained.
 *   2. CAP LEAK. `sumRecentOfframpUsd` counts everything except explicitly
 *      failed/cancelled/expired/rejected rows, so an abandoned `initiated` order
 *      burns the user's $200 daily allowance for a full 24h. Six abandoned taps
 *      could lock a user out of cash-out entirely.
 *   3. NO OPS SIGNAL. Nothing distinguished "in flight" from "dead".
 *
 * WHAT THIS DOES
 * --------------
 * For every non-terminal payout row older than the deposit window:
 *   • Ask the provider for the truth and apply it MONOTONICALLY (`status.ts`).
 *   • If the provider says nothing conclusive and the order was never funded,
 *     mark it `expired` , which frees the daily cap.
 *   • If it WAS funded and is still not terminal after `strandedAfterMs`, mark
 *     it `stranded` and surface it as refund-owed so a human/compensating job
 *     can act. Stranded is deliberately loud: it is the state where a user's
 *     money is gone and no payout happened.
 *
 * There is intentionally NO cron here. Per this repo's convention (money rules
 * are permissionless, fired on app-open) reconciliation is exposed as an
 * endpoint, `POST /api/offramp/reconcile`, and can be driven by a Vercel cron,
 * an ops call, or an app-open hook.
 */

export interface ReconcileSummary {
  scanned: number;
  advanced: number;
  expired: number;
  stranded: number;
  unchanged: number;
  providerErrors: number;
  refundsOwed: number;
  details: string[];
}

interface OpenRow {
  id: string;
  linq_order_id: string;
  user_id: string;
  status: string;
  amount_usdsui: string | number;
  created_at: number;
}

const NON_TERMINAL_SQL = `status NOT IN ('failed','cancelled','rejected','expired','stranded','manual_requested','disbursed','settled','completed')`;

/**
 * Reconcile Linq payout rows against the provider.
 *
 * `limit` bounds the work per invocation so a serverless call can't time out; a
 * caller that needs a full sweep calls it repeatedly (the oldest rows are
 * processed first, so progress is guaranteed).
 */
export async function reconcileLinqPayouts(opts?: {
  limit?: number;
  /** Skip provider calls; only apply the age-based rules. Useful when Linq is down. */
  offline?: boolean;
}): Promise<ReconcileSummary> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 500);
  const summary: ReconcileSummary = {
    scanned: 0,
    advanced: 0,
    expired: 0,
    stranded: 0,
    unchanged: 0,
    providerErrors: 0,
    refundsOwed: 0,
    details: [],
  };

  await ensureSchema();
  await ensureOfframpProviderSchema();
  const c = db();

  // Only rows past the deposit window + slack: a fresh order is legitimately
  // "initiated" and must never be expired out from under a user who is mid-send.
  const cutoff = Date.now() - DEPOSIT_WINDOW_SLACK_MS;
  const r = await c.execute({
    sql: `SELECT id, linq_order_id, user_id, status, amount_usdsui, created_at
            FROM linq_offramps
           WHERE ${NON_TERMINAL_SQL}
             AND linq_order_id <> 'manual'
             AND created_at < ?
           ORDER BY created_at ASC
           LIMIT ?`,
    args: [cutoff, limit],
  });
  const rows = r.rows as unknown as OpenRow[];
  summary.scanned = rows.length;

  const offline = opts?.offline === true || !linqConfigured();

  for (const row of rows) {
    // The SQL filter can only exclude status strings we know by name; Linq's
    // status text is free-form ("disbursed_to_bank", "payout_completed"…), so
    // re-check the PHASE in code and skip anything already terminal.
    if (isTerminalPhase(phaseOf(row.status))) {
      summary.unchanged++;
      continue;
    }
    const ageMs = Date.now() - Number(row.created_at);

    // 1. Ask the provider for the truth.
    let providerStatus: string | null = null;
    if (!offline) {
      try {
        const live = await getOrderStatus(row.linq_order_id);
        providerStatus = live.status ?? null;
        await reportProviderOutcome("linq", true);
      } catch (e) {
        summary.providerErrors++;
        const msg = (e as Error).message;
        if (isProviderSideFailure(e)) {
          await reportProviderOutcome("linq", false, msg);
        }
        summary.details.push(`${row.id}: provider status unavailable (${msg})`);
      }
    }

    if (providerStatus) {
      const phase = phaseOf(providerStatus);
      const write = await applyLinqStatus({
        linqOrderId: row.linq_order_id,
        status: providerStatus,
        source: "reconcile",
        reason: `age=${Math.round(ageMs / 60_000)}m`,
      });
      if (write.applied) {
        summary.advanced++;
        summary.details.push(
          `${row.id}: ${write.fromPhase} → ${write.toPhase} ("${providerStatus}")`
        );
        continue;
      }
      if (phase === "processing" || phase === "completed") {
        // Provider says it is alive and working; nothing to do but wait, unless
        // it has been "working" for far too long (handled below).
        if (ageMs < strandedAfterMs()) {
          summary.unchanged++;
          continue;
        }
      }
    }

    // 2. Nothing conclusive from the provider. Decide by age + funding.
    //    A row is "funded" iff we have on-chain evidence recorded for it (see
    //    `POST /api/offramp/linq/deposit`). Absence of evidence is treated as
    //    NOT funded, which is the safe direction for expiry (expiring a row only
    //    frees the user's cap, it never claims a payout succeeded).
    const funded = await isAttemptFunded(row.linq_order_id);

    if (!funded) {
      // Never funded, past the deposit window: dead. Close it out so the user's
      // daily allowance is returned.
      const ok = await closeRow(row, "expired", "no deposit received within the deposit window");
      if (ok) {
        summary.expired++;
        summary.details.push(`${row.id}: expired (never funded, age ${Math.round(ageMs / 60_000)}m)`);
      } else {
        summary.unchanged++;
      }
      continue;
    }

    if (ageMs >= strandedAfterMs()) {
      // FUNDED, and still not terminal long after it should have settled. The
      // user is out the money. Make it loud and make it a refund obligation.
      const ok = await closeRow(
        row,
        "stranded",
        "funded but provider never reached a terminal state, refund owed"
      );
      if (ok) {
        summary.stranded++;
        console.error(
          `[offramp/reconcile] STRANDED payout, user=${row.user_id} row=${row.id} ` +
            `order=${row.linq_order_id} usd=${row.amount_usdsui} age=${Math.round(ageMs / 3_600_000)}h ` +
            `, the user was debited on-chain and no payout completed. REFUND REQUIRED.`
        );
        try {
          await settleAttempt({
            provider: "linq",
            providerRef: row.linq_order_id,
            state: "stranded",
            terminal: true,
            needsRefund: true,
            reason: "reconcile: funded, provider never settled",
          });
        } catch (e) {
          console.warn("[offramp/reconcile] attempt-ledger stranded flag failed:", (e as Error).message);
        }
        summary.details.push(`${row.id}: STRANDED (refund owed)`);
      } else {
        summary.unchanged++;
      }
      continue;
    }

    summary.unchanged++;
  }

  try {
    summary.refundsOwed = (await listRefundsOwed(500)).length;
  } catch {
    /* diagnostic only */
  }
  return summary;
}

/** Has an on-chain deposit been recorded for this provider order? */
async function isAttemptFunded(providerRef: string): Promise<boolean> {
  try {
    const r = await db().execute({
      sql: `SELECT funded FROM offramp_attempts
             WHERE provider = 'linq' AND provider_ref = ? LIMIT 1`,
      args: [providerRef],
    });
    return r.rows[0]?.funded === true;
  } catch {
    // No ledger row / unreadable: treat as not funded. Safe direction, expiring
    // an un-funded row only returns cap headroom.
    return false;
  }
}

/**
 * Write a terminal status, guarded on the status we observed so a concurrent
 * webhook can't be clobbered.
 */
async function closeRow(
  row: OpenRow,
  status: "expired" | "stranded",
  reason: string
): Promise<boolean> {
  const upd = await db().execute({
    sql: `UPDATE linq_offramps
             SET status = ?, status_reason = ?, updated_at = ?
           WHERE id = ? AND status = ?`,
    args: [status, `reconcile: ${reason}`.slice(0, 500), Date.now(), row.id, row.status],
  });
  return (upd.rowsAffected ?? 0) > 0;
}

/** The refund queue: funded payouts that failed and owe the user their money. */
export async function refundQueue(limit = 100) {
  await ensureOfframpProviderSchema();
  return listRefundsOwed(limit);
}
