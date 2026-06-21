import { NextResponse } from "next/server";
import { readEntryIdFromRequest, isMobileRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { requireAppAttestStructural } from "@/lib/app-attest";
import {
  getChequeForClaim,
  checkClaimEligibility,
  ipFromRequest,
  releaseCheque,
  recordClaimAttempt,
  microsToUsd,
} from "@/lib/cheques";

export const runtime = "nodejs";

/**
 * POST /api/cheques/:id/claim/release  { secret, turnstileToken }
 *
 * The choke point. Re-validates the secret, runs the claim gates SERVER-SIDE
 * (captcha + optional IP-country allowlist — never trusts the
 * client), atomically claims the row (double-claim lock), then releases
 * escrow→claimer.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const attestBlock = requireAppAttestStructural(req);
  if (attestBlock) return attestBlock;

  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { id } = await params;
  let body: { secret?: string; turnstileToken?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const cq = await getChequeForClaim(id, body.secret ?? "");
  if (!cq) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (cq.status !== "funded" || cq.expiresAt < Date.now()) {
    return NextResponse.json({ error: "not_claimable", status: cq.status }, { status: 409 });
  }

  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  // Gates, server-side: captcha + optional IP-country allowlist.
  const ip = ipFromRequest(req);
  const elig = await checkClaimEligibility({
    chequeId: id,
    ip,
    turnstileToken: body.turnstileToken ?? null,
    // Native app = App Attest + bearer gated; captcha is a web-claim defense.
    skipCaptcha: isMobileRequest(req),
  });
  if (!elig.ok) {
    await recordClaimAttempt({
      chequeId: id,
      userId,
      passed: false,
      failedGate: elig.reason,
      ip,
      country: elig.country ?? null,
      isVpn: elig.isVpn ?? null,
    });
    const msg =
      elig.reason === "captcha"
        ? "Captcha check failed — please try again."
        : elig.reason === "country"
          ? "This cheque can't be claimed from your country."
          : "We couldn't verify your location for this cheque's country rule — please try again.";
    return NextResponse.json({ error: msg, code: "GATE_FAILED", reason: elig.reason }, { status: 403 });
  }

  // On-chain rail: releaseCheque has the worker sign `cheque::claim(recipient
  // = claimer address)` AFTER these captcha + country gates pass. Escrow
  // rail: it signs the gasless escrow→claimer transfer. Either way the
  // claimer's geolocated country is recorded for audit.
  const result = await releaseCheque({
    chequeId: id,
    claimerUserId: userId,
    claimerAddress: user.sui_address,
    claimerCountry: elig.country ?? null,
    // The on-chain rail's v2 hashlock check needs the preimage; already matched
    // against secret_hash in getChequeForClaim above.
    secret: body.secret ?? "",
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason ?? "release_failed" }, { status: 409 });
  }

  await recordClaimAttempt({
    chequeId: id,
    userId,
    passed: true,
    ip,
    country: elig.country ?? null,
    isVpn: false,
  });

  return NextResponse.json({
    ok: true,
    digest: result.digest,
    amountUsd: microsToUsd(cq.amountMicros),
  });
}
