import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { db } from "@/lib/db";
import {
  consumeAttestChallenge,
  ensureAttestKeysSchema,
  appAttestMode,
} from "@/lib/app-attest";
import { verifyAttestation } from "@/lib/app-attest-verify";

export const runtime = "nodejs";

/**
 * Persist the App Attest keyId + first attestation object.
 *
 * Phase 1 (this commit): we verify the challenge half of the protocol
 * (one-time, server-persisted nonce with 5-minute TTL) and store the
 * raw attestation blob keyed by the iOS Secure Enclave keyId.
 *
 * Phase 2 (deferred, see `TODO-APPATTEST.md`): full Apple chain
 * verification. Until that ships, a stolen bearer can still register
 * a forged attestation; the challenge layer just prevents replays.
 *
 * Schema is idempotent (shared with the gate via ensureAttestKeysSchema).
 */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { keyId?: string; attestation?: string; challenge?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!body.keyId || !body.attestation || !body.challenge) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }

  const consumed = await consumeAttestChallenge({
    nonce: body.challenge,
    userId,
  });
  if (!consumed.ok) {
    return NextResponse.json({ error: consumed.reason }, { status: 400 });
  }

  // F4: verify the attestation + extract the credential public key. In "log"
  // mode we store the verified key + log any chain warning but never reject
  // (no lockout before the Apple root CA is pinned and a real device fixture
  // validates the x5c chain). In "enforce" mode a deterministic failure is 401.
  let publicKeyB64: string | null = null;
  let chainVerified = 0;
  try {
    const att = verifyAttestation({
      attestationBase64: body.attestation,
      challenge: body.challenge,
    });
    publicKeyB64 = att.publicKeyDer.toString("base64");
    chainVerified = att.chainVerified ? 1 : 0;
    if (att.warnings.length) {
      console.warn(
        `[attest/register] user=${userId} key=${body.keyId} warnings: ${att.warnings.join("; ")}`
      );
    }
    // In enforce mode the full x5c→Apple-root chain + nonce + key-identity must
    // verify, or we refuse to register the key (so the assertion gate only ever
    // trusts device-attested keys).
    if (appAttestMode() === "enforce" && !att.chainVerified) {
      return NextResponse.json(
        { error: "attestation chain not verified" },
        { status: 401 }
      );
    }
  } catch (e) {
    console.warn(
      `[attest/register] verification failed user=${userId} key=${body.keyId}: ${(e as Error).message}`
    );
    if (appAttestMode() === "enforce") {
      return NextResponse.json(
        { error: "attestation verification failed" },
        { status: 401 }
      );
    }
    // log/off: fall through and store the raw blob without a verified key.
  }

  await ensureAttestKeysSchema();
  await db().execute({
    sql: `INSERT INTO app_attest_keys
            (key_id, user_id, attestation_blob, public_key, chain_verified, counter, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?)
          ON CONFLICT (key_id) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            attestation_blob = EXCLUDED.attestation_blob,
            public_key = EXCLUDED.public_key,
            chain_verified = EXCLUDED.chain_verified,
            counter = 0,
            created_at = EXCLUDED.created_at`,
    args: [body.keyId, userId, body.attestation, publicKeyB64, chainVerified, Date.now()],
  });
  return NextResponse.json({ ok: true });
}
