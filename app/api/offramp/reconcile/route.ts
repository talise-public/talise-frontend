import { NextResponse } from "next/server";

import { requireCron } from "@/lib/cron-auth";
import { reconcileLinqPayouts, refundQueue } from "@/lib/offramp/reconcile";

export const runtime = "nodejs";
// Reconciliation makes one provider call per open row; give it room.
export const maxDuration = 60;

/**
 * POST /api/offramp/reconcile , terminal-state reconciliation for fiat-out.
 *
 * Auth: `requireCron` (Vercel's `Authorization: Bearer $CRON_SECRET`), which
 * FAILS CLOSED, unset secret → 503, not an open endpoint.
 *
 * WHY THIS ENDPOINT EXISTS
 * ------------------------
 * A payout row previously only ever changed state because the provider's webhook
 * arrived or the user's app happened to poll. Both are optional; neither is
 * guaranteed. So orders sat non-terminal forever: the daily cap leaked, and a
 * user who funded an order that then failed at the provider was invisible.
 *
 * This sweep asks the provider for the truth, applies it monotonically, expires
 * never-funded orders (returning the user's daily allowance), and escalates
 * FUNDED-but-unsettled payouts as `stranded` + refund-owed.
 *
 * Query: ?limit=50 (1-500), &offline=1 to apply only the age-based rules when
 * the provider itself is down.
 *
 * GET returns the refund queue read-only, for an ops check without mutating.
 */
export async function POST(req: Request) {
  const unauthorized = requireCron(req);
  if (unauthorized) return unauthorized;

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const offline = url.searchParams.get("offline") === "1";

  try {
    const summary = await reconcileLinqPayouts({
      limit: Number.isFinite(limit) ? limit : 50,
      offline,
    });
    if (summary.stranded > 0 || summary.refundsOwed > 0) {
      console.error(
        `[offramp/reconcile] ATTENTION: ${summary.stranded} newly stranded, ` +
          `${summary.refundsOwed} payouts owe a refund.`
      );
    }
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    console.error("[offramp/reconcile] failed:", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: "reconcile_failed", reason: (e as Error).message },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  const unauthorized = requireCron(req);
  if (unauthorized) return unauthorized;
  try {
    const owed = await refundQueue(200);
    return NextResponse.json({ ok: true, count: owed.length, refundsOwed: owed });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }
}
