import "server-only";

import { bridgeFetch } from "./client";

/**
 * Bridge Transfers status (`/v0/transfers/{id}`), reconciliation for one-time
 * payments. The create calls live in onramp.ts / offramp.ts; this is the read
 * + cancel side. Push updates arrive via `transfer.*` webhooks; this GET is
 * for polling / reconciliation.
 */

/**
 * Transfer lifecycle (verbatim from Bridge's transfer-states page). The
 * terminal success is `payment_processed`; failures land in
 * undeliverable/returned/refunded/error/canceled.
 */
export type BridgeTransferState =
  | "awaiting_funds"
  | "in_review"
  | "funds_received"
  | "payment_submitted"
  | "payment_processed"
  | "undeliverable"
  | "returned"
  | "missing_return_policy"
  | "refund_in_flight"
  | "refund_failed"
  | "refunded"
  | "canceled"
  | "error";

export type BridgeTransferDetail = {
  id: string;
  state: BridgeTransferState;
  amount: string;
  currency?: string;
  on_behalf_of?: string;
  client_reference_id?: string;
  source_deposit_instructions?: Record<string, unknown>;
  receipt?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

/** Coarse status for UI: pending / settled / failed. */
export function transferOutcome(
  state: BridgeTransferState
): "pending" | "settled" | "failed" {
  switch (state) {
    case "payment_processed":
      return "settled";
    case "undeliverable":
    case "returned":
    case "refund_in_flight":
    case "refund_failed":
    case "refunded":
    case "canceled":
    case "error":
      return "failed";
    default:
      return "pending";
  }
}

/** Fetch a transfer by id (read its `state`). */
export async function getTransfer(id: string): Promise<BridgeTransferDetail> {
  return bridgeFetch<BridgeTransferDetail>(`transfers/${encodeURIComponent(id)}`);
}

/** Cancel a transfer that's still `awaiting_funds`. */
export async function cancelTransfer(id: string): Promise<void> {
  await bridgeFetch(`transfers/${encodeURIComponent(id)}`, {
    method: "DELETE",
    idempotencyKey: `transfer-cancel-${id}`,
  });
}
