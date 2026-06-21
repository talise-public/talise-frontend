import "server-only";

import crypto from "node:crypto";

/**
 * Bridge webhook signature verification.
 *
 * Bridge signs with RSA (NOT HMAC). The header carries a timestamp + a
 * base64 RSA signature; the signed payload is `"<timestamp>.<rawBody>"`,
 * verified against a per-endpoint PUBLIC key (PEM) issued when you create the
 * webhook endpoint in the Bridge dashboard.
 *
 *   X-Webhook-Signature: t=<unix_ms>,v0=<base64_rsa_sig>
 *   verify RSA-SHA256 over  `${t}.${rawBody}`  with BRIDGE_WEBHOOK_PUBKEY
 *
 * MUST run against the RAW request body (verify before JSON.parse). With no
 * `BRIDGE_WEBHOOK_PUBKEY` configured, `verifyBridgeWebhook` returns
 * `{ verified: false, reason: "no_pubkey" }` so the route can no-op safely in
 * dev without failing closed.
 */

function pubKey(): string | undefined {
  const k = process.env.BRIDGE_WEBHOOK_PUBKEY;
  if (!k) return undefined;
  // Allow the PEM to be stored with literal `\n` (single-line env value).
  return k.includes("-----BEGIN") ? k.replace(/\\n/g, "\n") : k;
}

function headerGet(
  headers: Headers | Record<string, string>,
  name: string
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return headers[name] ?? headers[name.toLowerCase()] ?? undefined;
}

/** Parse `t=<ms>,v0=<base64>` into its parts (order-independent). */
function parseSignatureHeader(
  h: string
): { t?: string; v0?: string } {
  const out: { t?: string; v0?: string } = {};
  for (const part of h.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") out.t = v;
    else if (k === "v0") out.v0 = v;
  }
  return out;
}

export type BridgeWebhookVerification =
  | { verified: true; timestampMs: number }
  | { verified: false; reason: string };

/**
 * Verify the signature over the RAW body. `maxSkewMs` rejects stale/replayed
 * events (default 10 min) — pass `nowMs` so callers can keep this pure/testable.
 */
export function verifyBridgeWebhook(
  rawBody: string,
  headers: Headers | Record<string, string>,
  opts?: { nowMs?: number; maxSkewMs?: number }
): BridgeWebhookVerification {
  const key = pubKey();
  if (!key) return { verified: false, reason: "no_pubkey" };

  const header = headerGet(headers, "x-webhook-signature");
  if (!header) return { verified: false, reason: "missing_signature_header" };

  const { t, v0 } = parseSignatureHeader(header);
  if (!t || !v0) return { verified: false, reason: "malformed_signature_header" };

  const tsMs = Number(t);
  if (!Number.isFinite(tsMs)) return { verified: false, reason: "bad_timestamp" };

  const now = opts?.nowMs ?? Date.now();
  const maxSkew = opts?.maxSkewMs ?? 10 * 60 * 1000;
  if (Math.abs(now - tsMs) > maxSkew) {
    return { verified: false, reason: "timestamp_out_of_tolerance" };
  }

  const ok = rsaVerify(key, `${t}.${rawBody}`, v0);
  return ok
    ? { verified: true, timestampMs: tsMs }
    : { verified: false, reason: "signature_mismatch" };
}

/**
 * RSA-verify the signed payload against Bridge's per-endpoint public key.
 *
 * Bridge's OFFICIAL sample is nonstandard: it SHA-256-hashes the signed
 * payload and feeds that DIGEST into an RSA-SHA256 verifier (which hashes
 * again) — i.e. it effectively signs `SHA256(SHA256(payload))`. We try that
 * exact form FIRST (it's what their docs show), then fall back to the
 * conventional single-hash form, so verification succeeds whichever Bridge
 * actually uses. Both are constant-work and only run on inbound webhooks.
 */
function rsaVerify(key: string, signedPayload: string, sigB64: string): boolean {
  // 1) Official Bridge form: pre-hash, then verify the digest.
  try {
    const digest = crypto.createHash("sha256").update(signedPayload, "utf8").digest();
    const v = crypto.createVerify("RSA-SHA256");
    v.update(digest);
    v.end();
    if (v.verify(key, sigB64, "base64")) return true;
  } catch {
    /* try the conventional form below */
  }
  // 2) Conventional form: verify directly over the raw signed payload.
  try {
    const v = crypto.createVerify("RSA-SHA256");
    v.update(signedPayload, "utf8");
    v.end();
    return v.verify(key, sigB64, "base64");
  } catch {
    return false;
  }
}

/** Normalized Bridge webhook envelope (`<category>.<mutation>` event types). */
export type BridgeWebhookEvent = {
  api_version?: string;
  event_id?: string;
  event_category?: string;
  /** e.g. "customer.updated.status_transitioned", "transfer.updated", … */
  event_type?: string;
  event_object_id?: string;
  event_object_status?: string;
  event_object?: Record<string, unknown>;
  event_object_changes?: Record<string, unknown>;
  event_created_at?: string;
};

/** Parse the (already-verified) raw body into the typed envelope. */
export function parseBridgeWebhook(rawBody: string): BridgeWebhookEvent {
  try {
    return JSON.parse(rawBody) as BridgeWebhookEvent;
  } catch {
    return {};
  }
}
