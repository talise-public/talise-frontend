import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/process-roundup-queue
 *
 * RETIRED (2026-06-01). Spend-and-Save no longer defers the NAVI supply:
 * a Save-ON send now routes through the SPONSORED path in
 * `/api/send/sponsor-prepare`, which bundles the transfer + the NAVI
 * supply ATOMICALLY in one user-signed tx (`appendNaviSupply`). So nothing
 * enqueues into `roundup_queue` anymore and this drain has no work. Kept as
 * a harmless empty-200 (any legacy rows simply never need draining); the
 * route + table can be removed in a later cleanup.
 *
 * Historical context (the deferral that this replaced):
 * TODO(P1): drain `roundup_queue` and execute deferred NAVI USDsui
 * supply legs.
 *
 * Context: USDsui sends now ALWAYS take the gasless rail (the
 * `0x2::coin::send_funds<T>` allowlist forbids co-bundling any other
 * MoveCall in the PTB). When the user has Spend-and-Save on,
 * `/api/send/sponsor-prepare` computes the rounded-up USDsui amount
 * and `/api/send/gasless-submit` inserts a row into `roundup_queue`
 * after the gasless tx lands. This cron is responsible for actually
 * executing the NAVI supply as a separate sponsored tx.
 *
 * Sketch of the real implementation (intentionally not built today -
 * the queue itself is what unblocks the speed win):
 *
 *   1. `pendingRoundups()` from `lib/db.ts` (already ships) returns
 *      up to N un-processed rows ordered by `created_at ASC`.
 *   2. For each row: build a NAVI supply PTB on behalf of the user
 *      (we have `user_id` → `sui_address` via `userById`), sponsor
 *      via Onara, sign as the user (here's the subtle part, supply
 *      from a custodial-equivalent path; needs the same zkLogin
 *      multisig story we use for /api/zk/sponsor-execute, OR a
 *      Talise-treasury supply that credits the user's position via
 *      `appendNaviSupply` from a service wallet).
 *   3. On success → `markRoundupProcessed(id, txDigest)`.
 *   4. On failure → leave the row pending; retry-bounded by a future
 *      `attempt_count` column.
 *
 * Cron schedule (when wired in `vercel.json`): every minute, same
 * cadence as `/api/cron/auto-swap-sweep`.
 *
 * Current behaviour: empty 200, Vercel's cron won't crash, and the
 * queue continues to accumulate rows safely (Postgres index is
 * partial on `processed_at IS NULL`, so unbounded growth here just
 * means each drain reads them when the real worker lands).
 */
export async function GET() {
  return NextResponse.json({ ok: true, processed: 0, todo: "P1" });
}
