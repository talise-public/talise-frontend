import "server-only";

import { bridgeFetch } from "./client";

/**
 * Bridge webhook ENDPOINT management (`/v0/webhooks`) — the setup side.
 * (Inbound signature verification lives in `lib/bridge/webhook.ts`.)
 *
 * Flow per the quick-start:
 *   1. registerWebhook({ url }) → returns { id: "wep_…", public_key, status:"disabled" }
 *   2. Save `public_key` as BRIDGE_WEBHOOK_PUBKEY (verifier reads it).
 *   3. activateWebhook(id) → status "active" (new endpoints start disabled).
 *   4. (optional) sendTestWebhook(id) to fire a test event.
 *
 * These are admin/ops calls (run once from a script or the admin panel), not
 * part of the request hot path.
 */

/** Event categories Talise subscribes to. */
export const TALISE_WEBHOOK_CATEGORIES = [
  "customer",
  "kyc_link",
  "transfer",
  "liquidation_address.drain",
  "virtual_account.activity",
] as const;

export type BridgeWebhookEndpoint = {
  id: string; // "wep_…"
  url: string;
  status: "active" | "disabled";
  /** PEM RSA public key for THIS endpoint — store it for signature verification. */
  public_key?: string;
  event_categories?: string[];
};

/**
 * Register a webhook endpoint. `eventEpoch`:
 *   • "webhook_creation" (default) — only events from now on.
 *   • "beginning_of_time" — replay all historical events.
 * Returns the endpoint incl. its `public_key` (save → BRIDGE_WEBHOOK_PUBKEY).
 * The endpoint starts `disabled`; call `activateWebhook` to turn it on.
 */
export async function registerWebhook(input: {
  url: string;
  eventEpoch?: "webhook_creation" | "beginning_of_time";
  eventCategories?: readonly string[];
  idempotencyKey: string;
}): Promise<BridgeWebhookEndpoint> {
  return bridgeFetch<BridgeWebhookEndpoint>("webhooks", {
    method: "POST",
    idempotencyKey: input.idempotencyKey,
    body: {
      url: input.url,
      event_epoch: input.eventEpoch ?? "webhook_creation",
      event_categories: input.eventCategories ?? TALISE_WEBHOOK_CATEGORIES,
    },
  });
}

/** Activate (or disable) an endpoint. New endpoints are created `disabled`. */
export async function setWebhookStatus(
  id: string,
  status: "active" | "disabled"
): Promise<BridgeWebhookEndpoint> {
  return bridgeFetch<BridgeWebhookEndpoint>(`webhooks/${encodeURIComponent(id)}`, {
    method: "PUT",
    idempotencyKey: `wh-status-${id}-${status}`,
    body: { status },
  });
}

/** Convenience: flip an endpoint to active. */
export function activateWebhook(id: string): Promise<BridgeWebhookEndpoint> {
  return setWebhookStatus(id, "active");
}

/** List all registered webhook endpoints. */
export async function listWebhooks(): Promise<{ data: BridgeWebhookEndpoint[] }> {
  return bridgeFetch<{ data: BridgeWebhookEndpoint[] }>("webhooks");
}

/** Delete a webhook endpoint. */
export async function deleteWebhook(id: string): Promise<void> {
  await bridgeFetch(`webhooks/${encodeURIComponent(id)}`, {
    method: "DELETE",
    idempotencyKey: `wh-del-${id}`,
  });
}

/** Fire a test event at an endpoint (verify your verifier end-to-end). */
export async function sendTestWebhook(id: string): Promise<void> {
  await bridgeFetch(`webhooks/${encodeURIComponent(id)}/send`, {
    method: "POST",
    idempotencyKey: `wh-test-${id}`,
  });
}
