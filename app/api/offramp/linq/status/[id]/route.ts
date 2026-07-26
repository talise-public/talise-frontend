import { NextResponse } from "next/server";

import { db, ensureSchema } from "@/lib/db";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { getOrderStatus, linqConfigured } from "@/lib/linq";
import { ProviderUnavailableError } from "@/lib/offramp/breaker";
import { applyLinqStatus, phaseOf } from "@/lib/offramp/status";

export const runtime = "nodejs";

interface Row {
  id: string;
  linq_order_id: string;
  user_id: string;
  amount_usdsui: string | number;
  amount_ngn: string | number;
  status: string;
  status_reason: string | null;
}

/**
 * GET /api/offramp/linq/status/[id]
 *
 * Poll a Linq off-ramp order by OUR row id. Proxies Linq's status, mirrors it
 * into `linq_offramps` MONOTONICALLY, and returns a coarse phase the UI renders.
 *
 * FIXED: the poll used to write the provider's status with an unconditional
 * UPDATE, so it raced the webhook and could walk a settled payout backwards to
 * "processing". Both writers now go through `applyLinqStatus`, where terminal
 * states are sticky and the UPDATE is guarded on the observed status.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!linqConfigured()) {
    return NextResponse.json({ error: "off-ramp not configured" }, { status: 503 });
  }
  const { id } = await params;

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // Polling is frequent but cheap, generous cap, still bounds abuse.
  const rl = await rateLimitAsync({ key: `offramp-linq-status:user:${userId}`, limit: 60, windowSec: 60 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } }
    );
  }

  await ensureSchema();
  const c = db();
  const r = await c.execute({
    sql: "SELECT * FROM linq_offramps WHERE id = ? LIMIT 1",
    args: [id],
  });
  const row = r.rows[0] as unknown as Row | undefined;
  if (!row) return NextResponse.json({ error: "order not found" }, { status: 404 });
  if (row.user_id !== String(userId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let status = row.status;
  let providerReachable = true;
  try {
    const live = await getOrderStatus(row.linq_order_id);
    if (live.status) {
      const write = await applyLinqStatus({
        linqOrderId: row.linq_order_id,
        status: live.status,
        source: "poll",
      });
      // Show the provider's answer when we accepted it; otherwise keep the
      // stored status, which is the one we refused to walk backwards from.
      status = write.applied ? live.status : row.status;
    }
  } catch (e) {
    // Provider unreachable (or its circuit is open): fall back to the last
    // stored status rather than inventing one. A degraded provider must never
    // make an in-flight payout look failed.
    providerReachable = false;
    const degraded = e instanceof ProviderUnavailableError;
    console.warn(
      `[offramp/linq/status] getOrderStatus ${degraded ? "skipped (circuit open)" : "failed"}:`,
      (e as Error).message
    );
  }

  return NextResponse.json({
    orderId: id,
    status,
    phase: phaseOf(status),
    amountUsdsui: Number(row.amount_usdsui),
    amountNgn: Number(row.amount_ngn),
    // Surfaced so the client can say "we can't reach the bank rail right now"
    // instead of implying the payout itself is stuck.
    providerReachable,
    statusReason: row.status_reason ?? null,
  });
}
