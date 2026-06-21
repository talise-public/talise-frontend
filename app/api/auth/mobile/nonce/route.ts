import { NextResponse } from "next/server";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { fromBase64 } from "@mysten/sui/utils";
import { generateNonce } from "@mysten/sui/zklogin";
import { rateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * POST /api/auth/mobile/nonce — compute the zkLogin nonce for a
 * device-generated ephemeral binding.
 *
 * The NATIVE Sign in with Apple flow needs the zkLogin nonce BEFORE the
 * OAuth round-trip: iOS sets it as `ASAuthorizationAppleIDRequest.nonce`
 * so Apple embeds it verbatim in the identity token's `nonce` claim, and
 * `/api/auth/mobile/exchange` later verifies the claim against the same
 * (ephemeralPubKey, maxEpoch, randomness) triple. iOS has no BN254
 * Poseidon implementation, so the computation lives here — the exact
 * same `generateNonce` call `/api/auth/mobile/start` makes for Google.
 *
 * Pure function of its inputs: unauthenticated by design (it mints
 * nothing and reveals nothing — the nonce is derivable by anyone holding
 * the same public inputs), rate-limited like /start.
 *
 * Body: { ephemeralPubKeyB64: string (32-byte Ed25519, std base64),
 *         maxEpoch: number, randomness: string (decimal bigint) }
 * → { nonce: string }
 */
export async function POST(req: Request) {
  const rl = rateLimit({
    key: `mobile-nonce:${getClientIp(req)}`,
    limit: 20,
    windowSec: 60,
  });
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: {
    ephemeralPubKeyB64?: string;
    maxEpoch?: number;
    randomness?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const { ephemeralPubKeyB64, maxEpoch, randomness } = body;
  if (
    typeof ephemeralPubKeyB64 !== "string" ||
    typeof maxEpoch !== "number" ||
    !Number.isInteger(maxEpoch) ||
    maxEpoch <= 0 ||
    typeof randomness !== "string" ||
    !/^\d+$/.test(randomness)
  ) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }

  let ephPubKey: Ed25519PublicKey;
  try {
    // Tolerate base64url from older clients, same as the exchange route.
    const normalized = ephemeralPubKeyB64.replace(/-/g, "+").replace(/_/g, "/");
    ephPubKey = new Ed25519PublicKey(fromBase64(normalized));
  } catch {
    return NextResponse.json(
      { error: "invalid ephemeralPubKeyB64" },
      { status: 400 }
    );
  }

  try {
    const nonce = generateNonce(ephPubKey, maxEpoch, randomness);
    return NextResponse.json({ nonce });
  } catch (err) {
    return NextResponse.json(
      { error: `nonce computation failed: ${(err as Error).message}` },
      { status: 400 }
    );
  }
}
