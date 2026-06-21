import { NextResponse } from "next/server";

import { db, ensureSchema } from "@/lib/db";
import { verifyLinqWebhook, parseLinqWebhook, phaseFromStatus } from "@/lib/linq";

export const runtime = "nodejs";

/**
 * POST /api/offramp/linq/webhook
 *
 * Linq order-state callback. The raw body is HMAC-SHA256 signed in the
 * `X-Linq-Signature: sha256=<hex>` header (keyed by LINQ_WEBHOOK_SECRET). We
 * verify it, then mirror the order state into `linq_offramps` by Linq's order
 * id. Idempotent — reprocessing the same event is a harmless no-op. Always
 * 2xx within 10s so Linq marks delivery successful; polling /status is the
 * reconciliation fallback for any missed event.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const sig = req.headers.get("x-linq-signature");

  if (!verifyLinqWebhook(raw, sig)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const evt = parseLinqWebhook(json);
  if (!evt.orderId) {
    // Nothing actionable, but acknowledge so Linq doesn't retry forever.
    return NextResponse.json({ ok: true, ignored: "no orderId" });
  }

  // Status text — prefer the event-implied phase when no explicit status.
  const statusText =
    evt.status ??
    (evt.event === "order.completed"
      ? "disbursed"
      : evt.event === "order.failed"
        ? "failed"
        : "processing");

  try {
    await ensureSchema();
    await db().execute({
      sql: `UPDATE linq_offramps SET status = ?, updated_at = ? WHERE linq_order_id = ?`,
      args: [statusText, Date.now(), evt.orderId],
    });
  } catch (e) {
    // Don't fail the webhook on a DB hiccup — Linq would retry/we reconcile via poll.
    console.warn("[offramp/linq/webhook] update failed:", (e as Error).message);
  }

  console.log(
    `[offramp/linq/webhook] order=${evt.orderId} event=${evt.event} phase=${phaseFromStatus(statusText)}`
  );
  return NextResponse.json({ ok: true });
}
