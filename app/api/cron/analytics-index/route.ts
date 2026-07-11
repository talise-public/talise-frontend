import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-auth";
import { runIndexBatch } from "@/lib/analytics/reindex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron/analytics-index
 *
 * Drives the on-chain analytics indexer: each batch advances a durable cursor
 * over the ordered user list, walks each user's tx history (gRPC + optional
 * SuiVision), and folds per-user aggregates + recent txs into Postgres
 * (analytics_user_stats / analytics_recent_tx / analytics_index_state). The
 * /dashboard-analytics page reads whatever is cached so far.
 *
 * Loops runIndexBatch() until a full pass completes (done) OR a ~50s wall-clock
 * budget elapses (leaving headroom under maxDuration=60). Resumable: the cursor
 * persists across invocations, so the next cron tick picks up where this left
 * off.
 *
 * Auth: Vercel adds `Authorization: Bearer $CRON_SECRET` to scheduled
 * invocations when CRON_SECRET is set — require it then; allow when unset (dev).
 */
export async function GET(req: Request) {
  const denied = requireCron(req);
  if (denied) return denied;

  const BUDGET_MS = 50_000;
  const start = Date.now();

  let batches = 0;
  let processed = 0;
  let cursor = 0;
  let total = 0;
  let done = false;

  try {
    do {
      const result = await runIndexBatch();
      batches += 1;
      processed += result.processed;
      cursor = result.cursor;
      total = result.total;
      done = result.done;

      // Stop if a full pass completed, or no users to index, or budget elapsed.
      if (done || total === 0) break;
    } while (Date.now() - start < BUDGET_MS);

    return NextResponse.json({ ok: true, batches, processed, cursor, total, done });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message, batches, processed, cursor, total, done },
      { status: 500 }
    );
  }
}
