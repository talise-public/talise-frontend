import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

import { verifyBridgeWebhook, parseBridgeWebhook } from "@/lib/bridge/webhook";
import { bridgeStateToStatus } from "@/lib/offramp/bridge-provider";
import { reportProviderOutcome } from "@/lib/offramp/breaker";
import { recordProviderEvent, settleAttempt } from "@/lib/offramp/store";
import { trackCashoutSettled } from "@/lib/analytics/emit";

export const runtime = "nodejs";

/**
 * POST /api/offramp/bridge/webhook
 *
 * Bridge off-ramp settlement events. Verify the RSA signature over the RAW body
 * BEFORE parsing, then PERSIST the outcome.
 *
 * WHAT WAS BROKEN
 * ---------------
 * This handler previously did nothing but `console.log` behind a
 * `TODO(persist)`. The consequence: the Bridge cash-out rail had NO terminal
 * state anywhere in Talise. A USD payout that Bridge `returned` or `canceled`
 * left the user out their USDC with no record that a payout had failed and
 * nothing to drive a refund from. It also had no replay protection, so a
 * redelivered event was reprocessed as if new.
 *
 * Now: dedupe on Bridge's own `event_id`, map the object state to a terminal
 * payout status, and mark a FUNDED-but-failed transfer as refund-owed so it
 * appears in `GET /api/offramp/reconcile`'s queue.
 *
 * Still always acks 200 (even for unverified/unknown) so Bridge doesn't retry
 * forever; the event is logged. An unverifiable event mutates NOTHING.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const v = verifyBridgeWebhook(raw, req.headers);
  if (!v.verified) {
    // FAIL CLOSED on state: an event we cannot authenticate never changes
    // anything. `no_pubkey` means BRIDGE_WEBHOOK_PUBKEY is unset, which in
    // production means the rail is running blind, so log it as an ERROR rather
    // than a shrug.
    const missingKey = v.reason === "no_pubkey";
    const line = `[offramp/bridge/webhook] unverified (${v.reason}), ignoring`;
    if (missingKey && process.env.NODE_ENV === "production") {
      console.error(
        `${line} , BRIDGE_WEBHOOK_PUBKEY is not configured, so NO Bridge payout settlement is being recorded.`
      );
    } else {
      console.warn(line);
    }
    return NextResponse.json({ ok: true, verified: false }, { status: 200 });
  }

  const evt = parseBridgeWebhook(raw);
  const type = evt.event_type ?? "unknown";
  const status = evt.event_object_status ?? "";
  const objId = evt.event_object_id ?? "";
  // Bridge supplies `event_id`; fall back to a body digest so dedupe still works
  // if a payload ever omits it.
  const eventId =
    evt.event_id ?? createHash("sha256").update(raw).digest("hex").slice(0, 40);

  try {
    const fresh = await recordProviderEvent({
      provider: "bridge",
      eventId,
      eventType: type,
      objectId: objId,
      objectStatus: status,
      payload: raw,
    });
    if (!fresh) {
      console.log(`[offramp/bridge/webhook] duplicate event ${eventId}, ignored`);
      return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
    }

    // A webhook arriving at all is evidence the rail is alive.
    await reportProviderOutcome("bridge", true);

    if (
      objId &&
      (type.startsWith("liquidation_address.drain") || type.startsWith("transfer"))
    ) {
      const mapped = bridgeStateToStatus(status);
      if (mapped !== "pending") {
        await settleAttempt({
          provider: "bridge",
          providerRef: objId,
          state: mapped === "settled" ? "settled" : "failed",
          terminal: true,
          // A funded attempt that Bridge failed/returned owes the user a refund.
          // `settleAttempt` only raises the flag for attempts we know were
          // funded, so this cannot manufacture phantom refund work.
          needsRefund: mapped === "failed",
          reason: `bridge webhook: ${type} ${status}`,
        });
        // GROWTH: the terminal payout outcome, after the state write. Runs only
        // for a FRESH event (the dedupe above already returned for a
        // redelivery), so a replayed webhook cannot double-count a cash-out.
        // The user is resolved from the attempt ledger inside `after()`, so this
        // adds nothing to the webhook's own latency and cannot change what we
        // ack to Bridge.
        trackCashoutSettled({
          provider: "bridge",
          providerRef: objId,
          ok: mapped === "settled",
          errorCode: mapped === "failed" ? "PROVIDER_FAILED" : undefined,
        });
        if (mapped === "failed") {
          console.error(
            `[offramp/bridge/webhook] FAILED payout obj=${objId} state=${status} , ` +
              `if this transfer was funded the user is owed a refund (see /api/offramp/reconcile).`
          );
        }
      }
    }
    console.log(`[offramp/bridge/webhook] ${type} status=${status} obj=${objId}`);
  } catch (e) {
    console.warn("[offramp/bridge/webhook] persist failed:", (e as Error).message);
  }

  return NextResponse.json({ ok: true, verified: true }, { status: 200 });
}
