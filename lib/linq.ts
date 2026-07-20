import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Linq B2B off-ramp client, USDSUI → NGN bank payout.
 *
 * Replaces the Paga integration. Linq is a complete payout engine: we create
 * an order and it hands back a DEPOSIT wallet address it watches; the user
 * sends USDSUI there and Linq pays the bank itself. So, unlike the Paga path
 *, Talise needs NO treasury float, NO on-chain verification, and NO refund
 * machinery: Linq owns deposit detection, the 10-minute timeout, and payout.
 *
 * Auth: every endpoint except GET /b2b/rate needs `X-API-Key`. Webhooks are
 * signed `X-Linq-Signature: sha256=<hex>` (HMAC-SHA256 of the raw body, keyed
 * by the webhook secret, SEPARATE from the API key).
 *
 * Env (set after one-time `POST /b2b/signup` with the invite code):
 *   LINQ_API_KEY         biz_live_…   (X-API-Key)
 *   LINQ_WEBHOOK_SECRET  whsec_…      (webhook HMAC key)
 *   LINQ_BASE_URL        optional override of the default host
 *
 * Coin: USDSUI on Sui (6 decimals), same contract Talise uses
 * (0x44f838…::usdsui::USDSUI), verified identical to USDSUI_TYPE.
 */

const DEFAULT_BASE_URL =
  "https://confidential-brianna-uselinq-52e2b233.koyeb.app";

/**
 * The ONLY coin Talise off-ramps. Linq also supports USDC, but we move USDSUI
 * end-to-end, sending it explicitly (rather than relying on Linq's "usdsui"
 * default) guarantees the deposit wallet watches for the same coin the client
 * sends. `USDSUI_CONTRACT` is the on-chain type; we assert order.coinType
 * matches it before letting the client deposit.
 */
export const LINQ_COIN = "usdsui" as const;
export const USDSUI_CONTRACT =
  "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";

/** True if a Linq order's coinType is our USDSUI (case-insensitive substring). */
export function isUsdsuiCoinType(coinType: string | null | undefined): boolean {
  const t = (coinType ?? "").toLowerCase();
  return t.includes("::usdsui::usdsui") || t.includes(USDSUI_CONTRACT.toLowerCase());
}

export interface LinqConfig {
  baseUrl: string;
  apiKey: string;
}

/** API config for authenticated calls. Throws if LINQ_API_KEY is unset. */
export function linqConfig(): LinqConfig {
  const apiKey = process.env.LINQ_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Linq client misconfigured: missing LINQ_API_KEY (run POST /b2b/signup with your invite code to obtain one)"
    );
  }
  return {
    baseUrl: process.env.LINQ_BASE_URL?.trim() || DEFAULT_BASE_URL,
    apiKey,
  };
}

/** Whether the Linq off-ramp is configured (API key present). */
export function linqConfigured(): boolean {
  return Boolean(process.env.LINQ_API_KEY?.trim());
}

/**
 * Product gate for bank cash-out. CLOSED by default for the TestFlight launch.
 * Open by setting `FEATURE_CASHOUT=true` in Vercel, the SAME flag the app's
 * UI reads via /api/me, so one env var opens both the UI and this backend at
 * once. Gating here (not just the UI) closes cash-out for already-installed
 * builds and any direct API call too.
 */
export function cashoutFeatureOpen(): boolean {
  // OPEN by default now that failed payouts auto-refund (refundAddress is set
  // on every order). Close again by setting FEATURE_CASHOUT=false in Vercel.
  return process.env.FEATURE_CASHOUT?.trim().toLowerCase() !== "false";
}

/** User-facing copy when cash-out is gated closed. */
export const CASHOUT_CLOSED_MESSAGE =
  "Cash-out to bank isn't available yet, it's coming soon. Your balance is untouched.";

function baseUrl(): string {
  return process.env.LINQ_BASE_URL?.trim() || DEFAULT_BASE_URL;
}

interface LinqErrorBody {
  message?: string;
  [k: string]: unknown;
}

async function linqFetch<T>(
  path: string,
  init: { method: "GET" | "POST"; auth?: boolean; body?: unknown }
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.auth) headers["X-API-Key"] = linqConfig().apiKey;

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl()}${path}`, {
      method: init.method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch (e) {
    throw new Error(`Linq ${path} network error: ${(e as Error).message}`);
  }

  const text = await resp.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Linq ${path} returned non-JSON (HTTP ${resp.status}): ${text.slice(0, 200)}`
    );
  }
  if (!resp.ok) {
    const msg = (json as LinqErrorBody)?.message ?? `HTTP ${resp.status}`;
    throw new Error(`Linq ${path} failed: ${msg}`);
  }
  return json as T;
}

// ─── Rate ──────────────────────────────────────────────────────────────

export interface LinqRate {
  rate: number;
  currency: string;
  coin: string;
}

/** Current display rate (1 USDSUI = `rate` NGN). No auth. The order locks its own rate. */
export async function getRate(): Promise<LinqRate> {
  return linqFetch<LinqRate>("/b2b/rate", { method: "GET" });
}

// ─── Verify bank ─────────────────────────────────────────────────────────

export interface VerifyBankResult {
  accountName: string;
  bankName: string;
  accountNumber: string;
  bankCode: string;
}

/** Resolve an account holder name. Always call before creating an order. */
export async function verifyBank(input: {
  bankCode: string;
  accountNumber: string;
}): Promise<VerifyBankResult> {
  return linqFetch<VerifyBankResult>("/b2b/verifybank", {
    method: "POST",
    auth: true,
    body: { bankCode: input.bankCode, accountNumber: input.accountNumber },
  });
}

// ─── Create order ──────────────────────────────────────────────────────

export interface CreateOrderInput {
  amountStableCoin: number;
  bankAccount: string;
  bankCode: string;
  bankName: string;
  accountName: string;
  /**
   * Sui wallet to auto-refund the stablecoin to if the bank payout fails.
   * STRONGLY RECOMMENDED, without it, a failed payout leaves the deposit
   * stuck pending manual support. Always the address that SENT the deposit.
   */
  refundAddress?: string;
  /**
   * Stablecoin to off-ramp. Defaults to USDSUI, the only coin Talise moves.
   * Sent explicitly so the deposit wallet never ends up watching for USDC.
   */
  coin?: "usdsui" | "usdc";
  /** Your own reference (echoed in webhooks). */
  customerRef?: string;
  /** Unique per order, re-sending the same key returns the original order. */
  idempotencyKey: string;
}

export interface CreateOrderResult {
  id: string;
  walletAddress: string;
  coinType: string;
  amountStableCoin: number;
  amountNGN: number;
  rate: number;
  currency: string;
  status: string;
}

/**
 * Create an off-ramp order. Returns a deposit `walletAddress` the user must
 * send exactly `amountStableCoin` USDSUI to within 10 minutes; Linq then pays
 * `amountNGN` to the bank automatically. The rate is locked at creation.
 */
export async function createOrder(
  input: CreateOrderInput
): Promise<CreateOrderResult> {
  return linqFetch<CreateOrderResult>("/b2b/offramp", {
    method: "POST",
    auth: true,
    body: {
      amountStableCoin: input.amountStableCoin,
      bankAccount: input.bankAccount,
      bankCode: input.bankCode,
      bankName: input.bankName,
      accountName: input.accountName,
      currency: "NGN",
      // Pin the coin to USDSUI explicitly (never rely on the server default).
      coin: input.coin ?? LINQ_COIN,
      // Auto-refund target if the bank payout fails (Linq sweeps the deposit
      // back here). Omitted only when the caller couldn't supply one.
      ...(input.refundAddress ? { refundAddress: input.refundAddress } : {}),
      customerRef: input.customerRef,
      idempotencyKey: input.idempotencyKey,
    },
  });
}

// ─── Status ──────────────────────────────────────────────────────────────

export interface LinqOrderStatus {
  id: string;
  status: string;
  amountStableCoin: number;
  amountNGN: number;
  currency: string;
  created?: string;
  updated?: string;
}

export async function getOrderStatus(id: string): Promise<LinqOrderStatus> {
  return linqFetch<LinqOrderStatus>(
    `/b2b/status?id=${encodeURIComponent(id)}`,
    { method: "GET", auth: true }
  );
}

/** Map Linq's free-text status strings to a coarse terminal/in-flight state. */
export type LinqPhase = "initiated" | "processing" | "completed" | "failed";

export function phaseFromStatus(status: string): LinqPhase {
  const s = (status ?? "").toLowerCase();
  if (s.includes("disbursed") || s.includes("settled") || s.includes("completed")) {
    return "completed";
  }
  // Terminal failure ONLY. A Linq "timeout" is transient (the bank payout is
  // lagging, not dead), so we treat it as still-processing and keep polling
  // instead of flashing a premature "failed" the user then watches succeed.
  if (s.includes("failed") || s.includes("reject")) {
    return "failed";
  }
  if (
    s.includes("processing") ||
    s.includes("queue") ||
    s.includes("worker") ||
    s.includes("timeout") ||
    s.includes("pending")
  ) {
    return "processing";
  }
  return "initiated";
}

// ─── Webhook verification ──────────────────────────────────────────────

/**
 * Verify an inbound Linq webhook. The `X-Linq-Signature` header is
 * `sha256=<hex>` of the RAW request body, HMAC-SHA256 with LINQ_WEBHOOK_SECRET.
 * Returns false on any mismatch / missing secret-or-header.
 */
export function verifyLinqWebhook(
  rawBody: string,
  signatureHeader: string | null | undefined
): boolean {
  const secret = process.env.LINQ_WEBHOOK_SECRET?.trim();
  if (!secret || !signatureHeader) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader.trim(), "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export type LinqWebhookEvent = {
  event: "order.processing" | "order.completed" | "order.failed" | string;
  orderId: string | null;
  amountNGN: number | null;
  amountStableCoin: number | null;
  status: string | null;
};

/** Normalize a parsed Linq webhook body. */
export function parseLinqWebhook(json: Record<string, unknown>): LinqWebhookEvent {
  return {
    event: typeof json.event === "string" ? json.event : "unknown",
    orderId: typeof json.orderId === "string" ? json.orderId : null,
    amountNGN: typeof json.amountNGN === "number" ? json.amountNGN : null,
    amountStableCoin:
      typeof json.amountStableCoin === "number" ? json.amountStableCoin : null,
    status: typeof json.status === "string" ? json.status : null,
  };
}

// ─── Off-ramp cap (per-account, per-day) ──────────────────────────────────
/** Daily off-ramp USD cap PER ACCOUNT. Enforced server-side in every Linq
 *  entry point (quote / create / to-user / concierge request) against the
 *  trailing-24h sum of the user's cash-outs. KYC unlocks higher limits. */
export const OFFRAMP_MAX_USD = 200;

/** Rolling window for the daily cap. */
export const OFFRAMP_WINDOW_MS = 24 * 60 * 60 * 1000;

export type OfframpCapStatus = {
  ok: boolean;
  used: number;
  remaining: number;
  max: number;
  /** User-facing message + code when `ok` is false. */
  error?: string;
  code?: string;
};

/**
 * Check a proposed off-ramp of `addUsd` against the user's per-account daily
 * cap. Sums the trailing-24h cash-outs from `linq_offramps` (via db) and
 * returns whether this one fits, plus a KYC-upsell message when it doesn't.
 */
export async function checkDailyOfframpCap(
  userId: number | string,
  addUsd: number
): Promise<OfframpCapStatus> {
  const { sumRecentOfframpUsd } = await import("@/lib/db");
  const used = await sumRecentOfframpUsd(userId, Date.now() - OFFRAMP_WINDOW_MS);
  const remaining = Math.max(0, OFFRAMP_MAX_USD - used);
  const ok = addUsd <= remaining + 1e-9;
  return {
    ok,
    used,
    remaining,
    max: OFFRAMP_MAX_USD,
    ...(ok
      ? {}
      : {
          error: `Cash-outs are capped at $${OFFRAMP_MAX_USD} per day. You have $${remaining.toFixed(2)} left today, verify your identity (KYC) to raise your limit.`,
          code: "OFFRAMP_DAILY_CAP",
        }),
  };
}
