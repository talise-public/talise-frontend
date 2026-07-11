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
 * Kick off the CLI OAuth flow (`talise login`).
 *
 * Identical zkLogin binding to `/api/auth/mobile/start` — generate maxEpoch +
 * randomness, compute the canonical zkLogin nonce from the CLI's ephemeral
 * pubkey, send THAT to Google as the OIDC nonce, and stash the (pubkey,
 * maxEpoch, randomness) triple in a signed binding cookie so the callback can
 * persist it into `mobile_sessions`. The ONLY difference from the mobile flow is
 * the state shape: `cli.<port>.<csrf>.<rand>` so `/auth/callback` knows to
 * redirect the bearer + binding back to the CLI's loopback server on
 * `http://127.0.0.1:<port>` instead of the `talise://` app scheme.
 *
 * The CLI holds the ephemeral PRIVATE key (never sent here); it signs sends
 * locally and the server assembles the zkLogin proof — same non-custodial model
 * as the apps.
 */
const STATE_BINDING_COOKIE = "talise_m1_binding";
const MAX_EPOCH_HORIZON = 2; // current_epoch + 2 → ~48h window

export async function GET(req: Request) {
  const rl = rateLimit({ key: `cli-start:${getClientIp(req)}`, limit: 10, windowSec: 60 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } },
    );
  }

  const url = new URL(req.url);
  const ephemeralPubKeyRaw = url.searchParams.get("ephemeralPubKey") ?? "";
  const portRaw = url.searchParams.get("port") ?? "";
  const csrf = url.searchParams.get("csrf") ?? "";

  if (ephemeralPubKeyRaw.length < 8 || ephemeralPubKeyRaw.length > 256) {
    return NextResponse.json({ error: "bad ephemeralPubKey" }, { status: 400 });
  }
  // Loopback port only — the callback will redirect the bearer to 127.0.0.1:<port>.
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return NextResponse.json({ error: "bad port" }, { status: 400 });
  }
  // CSRF token is echoed back to the loopback so the CLI can prove the callback
  // belongs to the login it started. Constrain to a safe, URL-clean shape.
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(csrf)) {
    return NextResponse.json({ error: "bad csrf" }, { status: 400 });
  }

  // Normalize base64URL → standard base64 (same as the mobile route).
  const standardB64 = ephemeralPubKeyRaw.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "+");
  const ephemeralPubKey = standardB64 + "=".repeat((4 - (standardB64.length % 4)) % 4);

  let ephPubKey: Ed25519PublicKey;
  try {
    ephPubKey = new Ed25519PublicKey(fromBase64(ephemeralPubKey));
  } catch {
    return NextResponse.json(
      { error: "ephemeralPubKey is not a valid Ed25519 public key (32 bytes base64)" },
      { status: 400 },
    );
  }

  let maxEpoch: number;
  try {
    const currentEpoch = await getCurrentEpoch();
    maxEpoch = currentEpoch + MAX_EPOCH_HORIZON;
    if (!Number.isFinite(maxEpoch) || maxEpoch <= 0) throw new Error("invalid epoch");
  } catch (err) {
    return NextResponse.json(
      { error: "Could not read current Sui epoch: " + (err as Error).message },
      { status: 502 },
    );
  }

  const randomness = BigInt("0x" + randomBytes(16).toString("hex")).toString();
  const zkNonce = generateNonce(ephPubKey, maxEpoch, randomness);

  // State encodes the loopback target: cli.<port>.<csrf>.<rand>. The callback
  // parses it to build the 127.0.0.1 redirect and to echo the csrf back.
  const rawState = randomBytes(18).toString("base64url");
  const state = `cli.${port}.${csrf}.${rawState}`;

  const binding = sign(
    Buffer.from(JSON.stringify({ ephemeralPubKey, maxEpoch, randomness, rawState })).toString("base64url"),
  );

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
  const redirectUri = redirectUriFromRequest(req);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce: zkNonce,
    prompt: "select_account",
  });
  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}
