import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { sign, redirectUriFromRequest } from "@/lib/auth";
import { setStateCookie, cookieDomain } from "@/lib/session";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { fromBase64 } from "@mysten/sui/utils";
import { generateNonce } from "@mysten/sui/zklogin";
import { getCurrentEpoch } from "@/lib/sui-epoch";
import { rateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Kick off the mobile OAuth flow with a PROPER zkLogin nonce.
 *
 * The Shinami prover (and any zkLogin prover) verifies that:
 *
 *     jwt.nonce == poseidonHash(extendedEphemeralPublicKey,
 *                               maxEpoch, jwtRandomness)
 *
 * If they don't match, every subsequent proof mint fails with
 * `-32602 Invalid params`. The previous version of this route used
 * `nonce: rawState` (random bytes), which guaranteed a mismatch -
 * sign-in completed but every Send + Earn supply 500'd at the
 * proof-mint step.
 *
 * Fix: generate maxEpoch + randomness server-side, compute the
 * canonical zkLogin nonce, send THAT to Google as the OAuth nonce,
 * and stash the same triple in a signed cookie so the callback
 * route can persist them into mobile_sessions. The proof mint
 * later then reuses the exact same values that bound the JWT -
 * the prover accepts because the equation holds.
 */
const STATE_BINDING_COOKIE = "talise_m1_binding";
const MAX_EPOCH_HORIZON = 3; // current_epoch + 3 → ~72h (3-day) signing window

export async function GET(req: Request) {
  // Rate-limit: 10 starts per 60s per IP. Looser than /exchange because
  // a user may bounce between providers / restart the flow.
  const rl = rateLimit({
    key: `mobile-start:${getClientIp(req)}`,
    limit: 10,
    windowSec: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } }
    );
  }

  const url = new URL(req.url);
  const ephemeralPubKeyRaw = url.searchParams.get("ephemeralPubKey") ?? "";
  if (ephemeralPubKeyRaw.length < 8 || ephemeralPubKeyRaw.length > 256) {
    return NextResponse.json({ error: "bad ephemeralPubKey" }, { status: 400 });
  }

  // 1. Normalize base64 vs base64URL. iOS sends base64URL (so the
  //    `+` in standard base64 doesn't get URL-decoded into a space)
  //    and we accept either form here. The downstream Ed25519PublicKey
  //    constructor wants raw 32 bytes from standard base64.
  const standardB64 = ephemeralPubKeyRaw
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/\s/g, "+");
  const padded =
    standardB64 + "=".repeat((4 - (standardB64.length % 4)) % 4);
  const ephemeralPubKey = padded;

  let ephPubKey: Ed25519PublicKey;
  try {
    ephPubKey = new Ed25519PublicKey(fromBase64(ephemeralPubKey));
  } catch {
    return NextResponse.json(
      { error: "ephemeralPubKey is not a valid Ed25519 public key (32 bytes base64)" },
      { status: 400 }
    );
  }

  // Fetch the live Sui epoch; add the standard horizon so the proof
  // is valid for ~48h. If the RPC blips we cannot proceed, Shinami
  // requires a real epoch value.
  let maxEpoch: number;
  try {
    // Shared gRPC-backed helper (`LedgerService.getServiceInfo`); see
    // web/lib/sui-epoch.ts. Sub-plan 1.1 retired the JSON-RPC call here.
    const currentEpoch = await getCurrentEpoch();
    maxEpoch = currentEpoch + MAX_EPOCH_HORIZON;
    if (!Number.isFinite(maxEpoch) || maxEpoch <= 0) {
      throw new Error("invalid epoch");
    }
  } catch (err) {
    return NextResponse.json(
      { error: "Could not read current Sui epoch: " + (err as Error).message },
      { status: 502 }
    );
  }

  // Randomness as a decimal bigint string, the format Shinami's
  // prover expects. We use 16 random bytes for the same field-size
  // headroom the client-side generator uses.
  const randomness = BigInt("0x" + randomBytes(16).toString("hex")).toString();

  // 2. Compute the zkLogin nonce. This is the SAME value Shinami
  //    will recompute when minting the proof, so they must match
  //    bit-for-bit.
  const zkNonce = generateNonce(ephPubKey, maxEpoch, randomness);

  // 3. Signed binding cookie, the callback reads it to persist
  //    the (ephPubKey, maxEpoch, randomness) triple into
  //    mobile_sessions alongside (jwt, salt).
  const rawState = randomBytes(24).toString("base64url");
  const state = `m1.${rawState}`;
  const binding = sign(
    Buffer.from(
      JSON.stringify({ ephemeralPubKey, maxEpoch, randomness, rawState })
    ).toString("base64url")
  );

  // Set the OAuth state through the SAME shared helper the web flow uses, so
  // the cookie carries the `.talise.io` Domain (COOKIE_DOMAIN) exactly like
  // `readStateCookie`/`clearStateCookie` expect. Setting it host-only here (the
  // old bug) let a stale domain-scoped `talise_oauth_state` from a prior web
  // attempt coexist and shadow the fresh one, the callback would read the
  // wrong value and reject the sign-in with `bad_state`. One scope, one cookie.
  await setStateCookie(state);
  const jar = await cookies();
  jar.set(STATE_BINDING_COOKIE, binding, {
    httpOnly: true,
    domain: cookieDomain(),
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 300,
  });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "oauth not configured" }, { status: 500 });
  }
  // Derive the redirect URI from the host we're being called on so iOS
  // (hitting app.talise.io) and web (hitting talise.io) each round-trip
  // back to their own host. Both must be Authorized Redirect URIs in
  // Google Cloud Console.
  const redirectUri = redirectUriFromRequest(req);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    // The critical line, Google embeds this verbatim into the
    // id_token's `nonce` claim. The prover later checks it against
    // poseidonHash(extEphPubKey, maxEpoch, randomness).
    nonce: zkNonce,
    prompt: "select_account",
  });
  return NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  );
}
