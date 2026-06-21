import { NextResponse } from "next/server";

import { db, ensureSchema } from "@/lib/db";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { getOrderStatus, phaseFromStatus, linqConfigured } from "@/lib/linq";

export const runtime = "nodejs";

interface Row {
  id: string;
  linq_order_id: string;
  user_id: string;
  amount_usdsui: string | number;
  amount_ngn: string | number;
  status: string;
}

/**
 * GET /api/offramp/linq/status/[id]
 *
 * Poll a Linq off-ramp order by OUR row id. Proxies Linq's status, mirrors it
 * into `linq_offramps`, and returns a coarse phase the UI can render.
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
  // Polling is frequent but cheap — generous cap, still bounds abuse.
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
  try {
    const live = await getOrderStatus(row.linq_order_id);
    status = live.status || status;
    await c.execute({
      sql: "UPDATE linq_offramps SET status = ?, updated_at = ? WHERE id = ?",
      args: [status, Date.now(), id],
    });
  } catch (e) {
    // Linq unreachable — fall back to the last stored status.
    console.warn("[offramp/linq/status] getOrderStatus failed:", (e as Error).message);
  }

  return NextResponse.json({
    orderId: id,
    status,
    phase: phaseFromStatus(status),
    amountUsdsui: Number(row.amount_usdsui),
    amountNgn: Number(row.amount_ngn),
  });
}
