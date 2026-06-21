import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import { screenTransfer } from "@/lib/screening";
import { requireAppAttestStructural } from "@/lib/app-attest";
import {
  chequesEnabled,
  chequeOnchainCreateEnabled,
  escrowAddress,
  createCheque,
  getCheque,
  buildChequeCreateSponsored,
  usdToMicros,
  claimUrl,
  sha256hex,
  type ChequeGate,
} from "@/lib/cheques";

export const runtime = "nodejs";

const MIN_USD = 0.01; // gasless minimum (0.01 USDsui)
const MAX_USD = 10_000;

/**
 * POST /api/cheques/create
 *
 * Write a cheque (draft). Returns the escrow address + a claim URL; the client
 * then funds the cheque by sending `amount` USDsui to `escrowAddress` over the
 * normal send rail and calls /api/cheques/:id/confirm-funded with the digest.
 *
 * Body: { amountUsd, payeeLabel?, memo?, signatureName?, gates?: [{kind, allowed?}] }
 */
export async function POST(req: Request) {
  const attestBlock = requireAppAttestStructural(req);
  if (attestBlock) return attestBlock;

  if (!chequesEnabled()) {
    return NextResponse.json({ error: "cheques_disabled" }, { status: 503 });
  }
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  // Private-beta guardrail: account must be on the app allowlist.
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;

  const rl = await rateLimitAsync({ key: `cheques-create:user:${userId}`, limit: 30, windowSec: 3600 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }

  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  let body: {
    amountUsd?: number;
    payeeLabel?: string;
    memo?: string;
    signatureName?: string;
    /** Optional ISO-3166 alpha-2 country allowlist. Empty/absent = any country.
     *  The captcha is always enforced at web claims regardless. */
    allowedCountries?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const amountUsd = Number(body.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd < MIN_USD || amountUsd > MAX_USD) {
    return NextResponse.json(
      { error: `amount must be between ${MIN_USD} and ${MAX_USD}` },
      { status: 400 }
    );
  }

  const allowedCountries = (body.allowedCountries ?? [])
    .map((c) => String(c).toUpperCase().trim())
    .filter((c) => /^[A-Z]{2}$/.test(c));
  const gates: ChequeGate[] =
    allowedCountries.length > 0 ? [{ kind: "country", allowed: allowedCountries }] : [];

  // Sanctions screen the creator (fail-closed on a name hit). Recipient is the
  // Talise escrow, so only the creator side is screened here.
  const screen = await screenTransfer({
    senderAddr: user.sui_address,
    recipientAddr: escrowAddress(),
    senderName: user.business_name ?? user.name,
    recipientName: null,
  });
  if (!screen.allow) {
    return NextResponse.json(
      { error: "This cheque was blocked by a compliance screen.", code: "SCREENING_BLOCK" },
      { status: 403 }
    );
  }

  const { id, secret, expiresAt } = await createCheque({
    creatorUserId: userId,
    creatorAddress: user.sui_address,
    amountMicros: usdToMicros(amountUsd),
    payeeLabel: body.payeeLabel?.slice(0, 80) ?? null,
    memo: body.memo?.slice(0, 140) ?? null,
    signatureName: body.signatureName?.slice(0, 60) ?? user.business_name ?? user.name ?? null,
    gates,
  });

  // ── On-chain rail: return the Onara-SPONSORED `cheque::create` bytes ──
  // iOS signs `fundingBytes` and POSTs to /api/zk/sponsor-execute; the
  // resulting digest is then sent to /api/cheques/:id/confirm-funded, which
  // parses the created on-chain Cheque object id and flips draft→funded. When
  // the on-chain rail is OFF, we return the escrow address + claim URL exactly
  // as before (the client funds the escrow via the normal send rail).
  if (chequeOnchainCreateEnabled()) {
    try {
      const { bytes: fundingBytes, sponsor } = await buildChequeCreateSponsored({
        creatorAddress: user.sui_address,
        amountMicros: usdToMicros(amountUsd),
        expiryMs: expiresAt,
        // Talise cheques are shareable bearer links (recipient unknown at
        // create), so we commit the claim secret as an on-chain hashlock.
        // `sha256hex(secret)` == the DB `secret_hash` == the 32-byte digest the
        // contract checks at claim — the link IS the on-chain claim condition.
        hashlockHex: sha256hex(secret),
      });
      return NextResponse.json({
        chequeId: id,
        mode: "onchain",
        fundingBytes, // sponsor-ready; iOS signs → /api/zk/sponsor-execute
        sponsor,
        amountUsd,
        claimUrl: claimUrl(id, secret),
        secret, // returned once so the client can build the shareable link
        expiresAt,
        allowedCountries,
        requireCaptcha: true,
      });
    } catch (e) {
      // Build failure on the on-chain rail: the draft row is harmless (it
      // can be reclaimed/swept and was never funded). Surface a clean 500 so
      // the client can retry rather than silently funding nothing.
      const cq = await getCheque(id);
      console.error(
        `[cheques/create] on-chain create build failed cheque=${id} status=${cq?.status}: ${(e as Error).message}`
      );
      return NextResponse.json(
        { error: "Couldn't prepare the cheque. Please try again.", code: "ONCHAIN_BUILD_FAILED" },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({
    chequeId: id,
    mode: "escrow",
    escrowAddress: escrowAddress(),
    amountUsd,
    claimUrl: claimUrl(id, secret),
    secret, // returned once so the client can build the shareable link
    expiresAt,
    allowedCountries,
    requireCaptcha: true,
  });
}
