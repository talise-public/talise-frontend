import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { agentWalletsEnabled, agentWalletByToken, reserveAgentSpend, releaseAgentSpend } from "@/lib/agent-wallets";
import { agentGaslessSend } from "@/lib/agent-send";
import { resolveRecipient } from "@/lib/suins";
import { screenTransfer } from "@/lib/screening";
import { checkSendAllowed, recordSend } from "@/lib/send-limits";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";

export const runtime = "nodejs";

const ADDRESS_RE = /^0x[a-f0-9]{64}$/i;

/**
 * POST /api/agent/pay, custodial agent payment.
 *
 * Auth: `Authorization: Bearer tak_…` (an agent-wallet token). The server signs
 * server-side with the wallet's custodied ephemeral key. Runs the SAME guards as
 * a normal send, app-access allowlist, compliance screening, the rolling send
 * limit, plus the wallet's own daily USD cap (reserved before the send, released
 * on failure). USDsui only, gasless. Feature-gated OFF by default.
 *
 * Body: `{ to, amount, memo? }`, `to` is any recipient form (resolved here).
 */
export async function POST(req: Request) {
  if (!agentWalletsEnabled()) {
    return NextResponse.json({ error: "Agent wallets are not enabled.", code: "AGENT_WALLETS_OFF" }, { status: 503 });
  }

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token.startsWith("tak_")) {
    return NextResponse.json({ error: "missing agent token" }, { status: 401 });
  }

  const wallet = await agentWalletByToken(token);
  if (!wallet) return NextResponse.json({ error: "invalid or revoked agent token" }, { status: 401 });

  // Per-wallet rate limit (anti-abuse) on top of the daily cap.
  const rl = await rateLimitAsync({ key: `agent-pay:${wallet.id}`, limit: 60, windowSec: 3600 });
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } });
  }

  // The underlying account must itself be allowlisted to move money.
  const denied = await denyUnlessAppApproved(wallet.userId);
  if (denied) return denied;
  const user = await userById(wallet.userId);
  if (!user) return NextResponse.json({ error: "account not found" }, { status: 404 });

  let body: { to?: string; amount?: number | string; memo?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
  }
  const toInput = (body.to ?? "").trim();
  if (!toInput) return NextResponse.json({ error: "to is required" }, { status: 400 });

  // Resolve the recipient (handle / suins / 0x) → address.
  const resolved = ADDRESS_RE.test(toInput)
    ? { address: toInput.toLowerCase(), displayName: toInput }
    : await resolveRecipient(toInput);
  if (!resolved || !ADDRESS_RE.test(resolved.address)) {
    return NextResponse.json({ error: `could not resolve recipient "${toInput}"`, code: "RESOLVE_FAILED" }, { status: 400 });
  }
  if (resolved.address === wallet.suiAddress.toLowerCase()) {
    return NextResponse.json({ error: "can't pay your own wallet" }, { status: 400 });
  }

  // Compliance screen, HARD STOP (fail-closed on a sanctioned hit).
  const screen = await screenTransfer({
    senderAddr: wallet.suiAddress,
    recipientAddr: resolved.address,
    senderName: user.business_name ?? user.name,
    recipientName: null,
  });
  if (!screen.allow) {
    return NextResponse.json({ error: "blocked by a compliance screen", code: "SCREENING_BLOCK" }, { status: 403 });
  }

  // Rolling account send-limit gate (fiat-USD; USDsui is 1:1).
  const decision = await checkSendAllowed(wallet.userId, amount);
  if (!decision.allowed) {
    return NextResponse.json(
      { error: `This would exceed the account's ${decision.window} limit.`, code: "LIMIT_EXCEEDED", window: decision.window, limit: decision.limit, used: decision.used },
      { status: 403 },
    );
  }

  // Reserve against the wallet's daily cap BEFORE moving money.
  const reserved = await reserveAgentSpend(wallet.id, amount);
  if (!reserved.ok) {
    return NextResponse.json({ error: "daily spend cap exceeded for this agent wallet", code: "CAP_EXCEEDED" }, { status: 403 });
  }

  try {
    const { digest } = await agentGaslessSend({ wallet, toAddress: resolved.address, amountUsd: amount });
    void recordSend({ userId: wallet.userId, amountUsd: amount, asset: "USDsui", digest });
    return NextResponse.json({
      ok: true,
      digest,
      to: resolved.address,
      recipient: resolved.displayName,
      amount,
      memo: body.memo ?? null,
      suiscan: `https://suiscan.xyz/mainnet/tx/${digest}`,
      capRemaining: reserved.remaining,
    });
  } catch (err) {
    // The money did NOT move, release the reservation so the cap isn't burned.
    await releaseAgentSpend(wallet.id, amount);
    const msg = (err as Error).message ?? "send failed";
    console.warn(`[agent/pay] wallet=${wallet.id} failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
