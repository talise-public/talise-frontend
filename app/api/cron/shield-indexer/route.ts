import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-auth";
import { shieldConfigured } from "@/lib/shield/onchain";
import { runShieldIndexer } from "@/lib/shield/indexer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron/shield-indexer
 *
 * Drives the shielded-pool indexer: polls `suix_queryEvents` for NewCommitment
 * / NullifierSpent / NewPool and folds them into Postgres (shield_commitments /
 * shield_nullifiers / shield_pools), advancing a durable cursor. The
 * merkle-path service reads those tables — so transfers and withdraws (which
 * need a note's authentication path) depend on this running. Deposits use the
 * all-zero dummy path and work before the first poll.
 *
 * Idempotent + cheap (batched upserts, cursor advance in one txn). Dormant via
 * shieldConfigured() until SHIELD_PKG + SHIELD_POOL_USDSUI are set.
 *
 * Auth: Vercel adds `Authorization: Bearer $CRON_SECRET` to scheduled
 * invocations when CRON_SECRET is set — require it then; allow when unset (dev).
 */
export async function GET(req: Request) {
  const denied = requireCron(req);
  if (denied) return denied;

  if (!shieldConfigured()) {
    return NextResponse.json({ ok: true, skipped: "SHIELD_OFF" });
  }

  try {
    const result = await runShieldIndexer();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
