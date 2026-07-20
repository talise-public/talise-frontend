import { NextResponse } from "next/server";
import { verifyBridgeWebhook, parseBridgeWebhook } from "@/lib/bridge/webhook";

export const runtime = "nodejs";

/**
 * POST /api/offramp/bridge/webhook
 *
 * Bridge off-ramp settlement events. We care about liquidation-address drains
 * (USDsui received at a cash-out address → fiat paid out) and transfer status
 * transitions. Verify the RSA signature over the RAW body BEFORE parsing.
 *
 * Always acks 200 (even on unverified/unknown) so Bridge doesn't retry
 * forever, the event is logged. This route moves no money; it's a state
 * mirror for the cash-out lifecycle.
 *
 *   liquidation_address.drain.*      , fiat payout lifecycle
 *   transfer.updated.status_transitioned, one-off off-ramp transfers
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const v = verifyBridgeWebhook(raw, req.headers);
  if (!v.verified) {
    // Fail closed in production (a real secret is set) but never 500: log + ack
    // so retries don't pile up. `no_pubkey` = dev/unconfigured.
    console.warn(`[offramp/bridge/webhook] unverified (${v.reason}), ignoring`);
    return NextResponse.json({ ok: true, verified: false }, { status: 200 });
  }

  const evt = parseBridgeWebhook(raw);
  const type = evt.event_type ?? "unknown";
  const status = evt.event_object_status ?? "";
  const objId = evt.event_object_id ?? "";

  if (type.startsWith("liquidation_address.drain") || type.startsWith("transfer")) {
    // TODO(persist): reconcile `objId` → the user's cash-out + reflect the
    // payout state in activity. For now we log; the on-chain receipt + the
    // user's bank are the sources of truth until persistence lands.
    console.log(`[offramp/bridge/webhook] ${type} status=${status} obj=${objId}`);
  }

  return NextResponse.json({ ok: true, verified: true }, { status: 200 });
}
