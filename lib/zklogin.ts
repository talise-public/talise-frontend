import { jwtToAddress } from "@mysten/sui/zklogin";
import { randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

// Google's published signing keys (JWKS). `createRemoteJWKSet` fetches +
// caches the keys and rotates them automatically, so this is created once.
const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs")
);

// Apple's published signing keys, same fetch+cache+rotate idiom as Google's.
const APPLE_JWKS = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys")
);

type GoogleClaims = {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  aud: string;
  iss: string;
  exp: number;
};

/**
 * Verify a Google `id_token`'s SIGNATURE against Google's JWKS and validate
 * `iss` / `aud` / `exp`. Use this for ANY client-submitted token (e.g. the iOS
 * PKCE flow posts its own id_token to /api/auth/mobile/exchange).
 *
 * `decodeJwt` only base64-decodes the payload, trusting it for a
 * client-submitted token is an account-takeover hole (an attacker can forge
 * any `sub`). This throws on a bad signature, wrong issuer/audience, or expiry.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  audiences: string[]
): Promise<GoogleClaims> {
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: audiences,
  });
  return payload as unknown as GoogleClaims;
}

type AppleClaims = {
  sub: string;
  /** May be an @privaterelay.appleid.com relay address. Present whenever the
   *  user granted the email scope (Apple includes it on every identity token,
   *  not just the first sign-in). */
  email?: string;
  /** Apple sends this as a boolean OR the string "true"/"false". */
  email_verified?: boolean | string;
  /** Only present when iOS requested .fullName AND it's the first sign-in. */
  name?: string;
  /** The OAuth nonce iOS passed to ASAuthorization, for zkLogin this MUST be
   *  the Poseidon nonce derived from (ephemeralPubKey, maxEpoch, randomness). */
  nonce?: string;
  aud: string;
  iss: string;
  exp: number;
};

/**
 * Verify a native Sign in with Apple identity token: RS256 signature against
 * Apple's JWKS, `iss` === https://appleid.apple.com, `aud` === our bundle id,
 * `exp` still valid (jose enforces it). Same trust posture as
 * `verifyGoogleIdToken`, the token is CLIENT-SUBMITTED, so the signature
 * check is what stops a forged `sub` from taking over a victim's wallet.
 *
 * NOTE: Apple identity tokens expire ~10 minutes after issuance. Callers must
 * verify promptly (the exchange route runs within seconds of the native
 * sheet completing, so this is fine).
 */
export async function verifyAppleIdToken(
  idToken: string,
  audiences: string[]
): Promise<AppleClaims> {
  const { payload } = await jwtVerify(idToken, APPLE_JWKS, {
    issuer: "https://appleid.apple.com",
    audience: audiences,
    algorithms: ["RS256"],
  });
  return payload as unknown as AppleClaims;
}

/**
 * Generate a random user salt for zkLogin.
 * Must be < 2^128. We sample 16 random bytes and stringify as decimal.
 * The salt is what binds Google account → deterministic Sui address.
 * Lose the salt and the address is unrecoverable. Store carefully.
 */
export function generateSalt(): string {
  const bytes = randomBytes(16);
  const hex = bytes.toString("hex");
  return BigInt("0x" + hex).toString();
}

/**
 * Derive a Sui address from a Google JWT and a salt.
 * Uses `sub` claim by default (Google's stable user id).
 */
export function deriveSuiAddress(jwt: string, salt: string): string {
  // legacyAddress=false uses the post-2024 derivation; matches our prior addresses
  // because @mysten/zklogin defaulted to non-legacy too.
  return jwtToAddress(jwt, salt, false);
}

/**
 * Decode a JWT payload without verifying the signature.
 * Safe in our context because we only accept JWTs we just exchanged with
 * Google's token endpoint over TLS, not user-submitted JWTs.
 */
export function decodeJwt(jwt: string): {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  aud: string;
  iss: string;
  exp: number;
} {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  const payload = Buffer.from(parts[1], "base64url").toString("utf8");
  return JSON.parse(payload);
}
