import "server-only";

import crypto from "node:crypto";

/**
 * Bridge.xyz API client, the shared HTTP core for Talise's on-ramp
 * (fiat → USDsui on Sui) and off-ramp (USDsui on Sui → fiat) rails.
 *
 * Bridge (a Stripe company) issues USDsui, the "Sui Dollar," so it delivers
 * USDsui DIRECTLY on Sui, no swap. See lib/bridge/onramp.ts (virtual
 * accounts) and lib/bridge/offramp.ts (liquidation addresses).
 *
 * ENV-GATED, like every Talise ramp partner: with `BRIDGE_API_KEY` unset,
 * `bridgeConfigured()` is false and callers fall back to their stub/dormant
 * path, no network, no money. Nothing here touches the send/balance/limit
 * paths.
 *
 *   BRIDGE_API_KEY       , Api-Key header value (dashboard-issued)
 *   BRIDGE_API_BASE      , override base URL (default production)
 *   BRIDGE_WEBHOOK_PUBKEY, PEM public key for webhook RSA verification
 *
 * Auth: a custom `Api-Key` header (NOT Bearer). POSTs carry a unique
 * `Idempotency-Key` (24h replay window). Docs: https://apidocs.bridge.xyz
 */

const DEFAULT_BASE = "https://api.bridge.xyz/v0";

/**
 * Sui rail + currency identifiers, CENTRALIZED here. Per Bridge's USDC-on-Sui
 * integration, ALL Sui transactions use `payment_rail: "sui"` +
 * `currency: "usdc"` (Bridge delivers USDC on Sui, NOT "usdsui"). Talise's
 * existing USDC→USDsui swap (AutoConvertBanner) finishes money-in; cash-out
 * swaps USDsui→USDC before sending to Bridge.
 */
export const BRIDGE_SUI_RAIL = "sui";
export const BRIDGE_SUI_CURRENCY = "usdc";

/**
 * Talise's platform fee on Bridge ramps, as a string percent (e.g. "1.0" = 1%).
 * Applied to virtual accounts + transfers. Override via env; defaults to 1%.
 */
export function bridgeDeveloperFeePercent(): string {
  return process.env.BRIDGE_DEVELOPER_FEE_PERCENT || "1.0";
}

export function bridgeConfigured(): boolean {
  return !!process.env.BRIDGE_API_KEY;
}

function apiKey(): string {
  const k = process.env.BRIDGE_API_KEY;
  if (!k) throw new BridgeError("bridge_not_configured", "BRIDGE_API_KEY unset", 0);
  return k;
}

function baseUrl(): string {
  return (process.env.BRIDGE_API_BASE || DEFAULT_BASE).replace(/\/+$/, "");
}

/** A typed Bridge API error, carries the HTTP status + Bridge's error body. */
export class BridgeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

type BridgeRequest = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** JSON body (POST/PUT). */
  body?: unknown;
  /**
   * Idempotency key for POSTs, REQUIRED by Bridge on writes. Pass a stable,
   * caller-owned key (e.g. the Talise row id) so a retried create never
   * double-acts. Omitted on GET. A random uuid is generated when a POST omits
   * one, but prefer passing a deterministic key.
   */
  idempotencyKey?: string;
  /** Per-request timeout (ms). Default 12s. */
  timeoutMs?: number;
};

/**
 * Low-level Bridge request. Throws {@link BridgeError} on a non-2xx response
 * or transport failure. Returns the parsed JSON body typed as `T`.
 */
export async function bridgeFetch<T = unknown>(
  path: string,
  req: BridgeRequest = {}
): Promise<T> {
  const method = req.method ?? "GET";
  const url = `${baseUrl()}/${path.replace(/^\/+/, "")}`;
  const headers: Record<string, string> = {
    "Api-Key": apiKey(),
    Accept: "application/json",
  };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    // Bridge requires Idempotency-Key on POST; default to a uuid if the caller
    // didn't supply a deterministic one.
    headers["Idempotency-Key"] = req.idempotencyKey || crypto.randomUUID();
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(req.timeoutMs ?? 12_000),
    });
  } catch (e) {
    throw new BridgeError("network", `bridge request failed: ${(e as Error).message}`, 0);
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { _unparsed: text };
    }
  }

  if (!res.ok) {
    const b = (parsed ?? {}) as { code?: string; message?: string; error?: string };
    throw new BridgeError(
      b.code || `http_${res.status}`,
      b.message || b.error || `Bridge ${method} ${path} → ${res.status}`,
      res.status,
      parsed
    );
  }
  return parsed as T;
}

/**
 * One-shot sanity check that Bridge accepts our Sui rail + USDC currency
 * identifiers, using a `dry_run` transfer (no money moves). Run this once
 * after setting BRIDGE_API_KEY to confirm `BRIDGE_SUI_RAIL` /
 * `BRIDGE_SUI_CURRENCY` are the strings Bridge expects. Returns
 * `{ ok: true }` on a clean dry run, or `{ ok: false, reason }` with Bridge's
 * complaint (e.g. an unknown-rail/currency validation error) so we can adjust
 * the centralized constants without guessing.
 */
export async function validateSuiRail(customerId: string): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  try {
    await bridgeFetch("transfers", {
      method: "POST",
      idempotencyKey: `suival-${customerId}`,
      body: {
        on_behalf_of: customerId,
        amount: "1.0",
        dry_run: true,
        source: { payment_rail: BRIDGE_SUI_RAIL, currency: BRIDGE_SUI_CURRENCY },
        destination: { payment_rail: "ach", currency: "usd" },
      },
    });
    return { ok: true };
  } catch (e) {
    const err = e as BridgeError;
    return { ok: false, reason: `${err.code}: ${err.message}` };
  }
}
