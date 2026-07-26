import "server-only";

import { db } from "@/lib/db";
import { ensureGrowthSchema } from "@/lib/analytics/growth-schema";
import {
  backfillTransferFees,
  ensureRevenueSchema,
} from "@/lib/analytics/growth-revenue";

/**
 * BACKFILL: make the milestone columns true for the accounts that already exist.
 *
 * The forward-looking emitters (lib/analytics/emit.ts) fill
 * `growth_user_firsts` from today onward. That alone leaves every metric with a
 * cohort denominator — activation, time-to-funded, D7 retention, revenue per
 * user — measurable only over accounts created after the wiring landed, i.e.
 * useless for the first month. Every column below has a REAL timestamp already
 * sitting in another table, so the corpus is derivable rather than lost.
 *
 * ── Discipline ───────────────────────────────────────────────────────────────
 *
 *  • ONE statement per column. Each is an `INSERT … SELECT … ON CONFLICT` that
 *    Postgres executes set-at-a-time; six round trips total, no per-user loop,
 *    no client-side paging. The prod pool is `max: 8` and shared with the money
 *    paths, so a backfill that opened a connection per user would be hostile.
 *  • Every write is `LEAST(COALESCE(existing, new), new)`, identical to the
 *    ingest path's set-once rule. So this is IDEMPOTENT, it can never move a
 *    milestone later, and a live emit racing it always wins if it is earlier.
 *  • NOTHING here is called from a request path. It is driven explicitly from
 *    `POST /api/admin/growth/metrics` (admin-gated). A backfill is a bounded
 *    admin action, not something a user's app-open should trigger.
 *
 * ── What each column is derived FROM, and how honest that is ─────────────────
 *
 *  signup_completed_at  users.created_at. GROUND TRUTH — the account row's own
 *                       stamp. Exact.
 *  first_send_at        MIN(rewards_events.created_at) WHERE kind='send_earn'.
 *                       Written by the money path on every send, so exact to
 *                       within the same request.
 *  funded_at            MIN(analytics_tx_ledger.ts) WHERE direction='received'.
 *                       On-chain observation time. Exact for anything the
 *                       indexer has walked; a never-indexed address stays NULL
 *                       rather than guessing.
 *  first_cashout_at     MIN(offramp_attempts.updated_at) WHERE state='settled'.
 *                       The settlement write's own stamp. Exact.
 *  kyc_completed_at     MIN(kyc_upgrade_intents.created_at) WHERE
 *                       ekyc_status='approved'. A LOWER BOUND, not the approval
 *                       moment: the intent table records when the submission was
 *                       made and then overwrites `ekyc_status` in place, so the
 *                       verdict has no timestamp of its own. Good enough to
 *                       count "verified users" and to order a cohort; do not
 *                       quote it as a verification latency.
 *  push_enabled_at      MIN(device_token.updated_at). An UPPER BOUND: the table
 *                       has no `created_at`, so a re-registered token reads as
 *                       later than the original grant. Good enough for "how many
 *                       users are push-reachable"; not a precise grant time.
 *
 *  handle_claimed_at is deliberately NOT backfilled. `users.talise_username` is
 *  a bare column with no stamp and the authoritative claim time is the SuiNS
 *  mint's on-chain timestamp, which nothing in Postgres records. Inventing one
 *  (e.g. `users.created_at`) would put a fake number in a column a dashboard
 *  reads as fact. It fills from `handle_claimed` going forward instead.
 */

export type BackfillCounts = {
  signupCompleted: number;
  firstSend: number;
  funded: number;
  firstCashout: number;
  kycCompleted: number;
  pushEnabled: number;
  /** Rows of `transfers` given a derived FX-spread fee + a ledger entry. */
  transferFees: number;
  /** Column names whose statement failed (usually: source table absent). */
  skipped: string[];
};

/**
 * Set-once upsert of ONE milestone column from a sub-select yielding
 * (user_id, ts).
 *
 * The column name is a literal from the call sites below and never from input —
 * there is no parameter that can reach an identifier position.
 */
async function fillColumn(column: string, selectSql: string): Promise<number> {
  const r = await db().execute({
    sql: `INSERT INTO growth_user_firsts (user_id, ${column})
          ${selectSql}
          ON CONFLICT (user_id) DO UPDATE SET
            ${column} = LEAST(
              COALESCE(growth_user_firsts.${column}, EXCLUDED.${column}),
              EXCLUDED.${column})`,
    args: [],
  });
  return r.rowsAffected ?? 0;
}

/**
 * Derive every derivable milestone for every existing account.
 *
 * Never throws: a missing source table (a fresh database that has never run an
 * indexer batch, or an off-ramp rail that was never used) records the column in
 * `skipped` and the rest still land. Returns per-column row counts so a caller
 * can report what actually moved.
 */
export async function backfillUserFirsts(
  opts: { transferFeeLimit?: number } = {}
): Promise<BackfillCounts> {
  await ensureGrowthSchema();
  await ensureRevenueSchema().catch(() => {});

  const skipped: string[] = [];
  const run = async (column: string, sql: string): Promise<number> => {
    try {
      return await fillColumn(column, sql);
    } catch (e) {
      console.warn(`[growth-backfill] ${column} skipped: ${(e as Error)?.message ?? e}`);
      skipped.push(column);
      return 0;
    }
  };

  // Ground truth. Also the single highest-value statement here: SQL_ACTIVATION
  // and every cohort query keys off `signup_completed_at`, and without this it
  // is NULL for every account that predates the pipeline.
  const signupCompleted = await run(
    "signup_completed_at",
    `SELECT id, created_at
       FROM users
      WHERE deleted_at IS NULL AND created_at IS NOT NULL AND created_at > 0`
  );

  const firstSend = await run(
    "first_send_at",
    `SELECT user_id, MIN(created_at)
       FROM rewards_events
      WHERE kind = 'send_earn'
      GROUP BY user_id`
  );

  // Joined on address: the ledger is keyed by Sui address, not user id.
  const funded = await run(
    "funded_at",
    `SELECT u.id, MIN(l.ts)
       FROM users u
       JOIN analytics_tx_ledger l ON l.address = u.sui_address
      WHERE u.deleted_at IS NULL AND l.direction = 'received'
      GROUP BY u.id`
  );

  // `offramp_attempts.user_id` is TEXT while `users.id` is INTEGER, so the cast
  // is required. A non-numeric id (shouldn't exist) would abort the statement,
  // hence the regex guard rather than a bare cast.
  const firstCashout = await run(
    "first_cashout_at",
    `SELECT user_id::integer, MIN(updated_at)
       FROM offramp_attempts
      WHERE state = 'settled' AND user_id ~ '^[0-9]+$'
      GROUP BY user_id`
  );

  const kycCompleted = await run(
    "kyc_completed_at",
    `SELECT user_id, MIN(created_at)
       FROM kyc_upgrade_intents
      WHERE ekyc_status = 'approved'
      GROUP BY user_id`
  );

  const pushEnabled = await run(
    "push_enabled_at",
    `SELECT user_id, MIN(updated_at)
       FROM device_token
      GROUP BY user_id`
  );

  // Revenue side: FX spread on already-settled cross-border transfers. Bounded
  // per call (the default walks 200 rows); a caller loops until it returns 0.
  let transferFees = 0;
  try {
    transferFees = await backfillTransferFees(opts.transferFeeLimit ?? 200);
  } catch (e) {
    console.warn(`[growth-backfill] transfer fees skipped: ${(e as Error)?.message ?? e}`);
    skipped.push("transfers.fee_usd");
  }

  return {
    signupCompleted,
    firstSend,
    funded,
    firstCashout,
    kycCompleted,
    pushEnabled,
    transferFees,
    skipped,
  };
}
