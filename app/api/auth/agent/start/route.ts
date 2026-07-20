import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { sign, redirectUriFromRequest } from "@/lib/auth";
import { setStateCookie, cookieDomain } from "@/lib/session";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { toBase64 } from "@mysten/sui/utils";
import { generateNonce } from "@mysten/sui/zklogin";
import { getCurrentEpoch } from "@/lib/sui-epoch";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { agentWalletsEnabled } from "@/lib/agent-wallets";

export const runtime = "nodejs";

/**
 * Provision a CUSTODIAL agent wallet (`talise agent provision`).
 *
 * Mirrors `/api/auth/cli/start`, but the SERVER generates and CUSTODIES the
 * ephemeral key (that is the whole point, the agent host holds no key). The
 * key + binding + cap + name ride a short-lived signed cookie to the callback,
 * which persists them ENCRYPTED and mints a scoped agent token. Feature-gated
 * OFF by default (see agent-wallets.ts).
 */
const AGENT_BINDING_COOKIE = "talise_agw_binding";
const MAX_EPOCH_HORIZON = 2;

export async function GET(req: Request) {
  if (!agentWalletsEnabled()) {
    return NextResponse.json(
      { error: "Agent wallets are not enabled on this deployment.", code: "AGENT_WALLETS_OFF" },
      { status: 503 },
    );
  }

  const rl = rateLimit({ key: `agent-start:${getClientIp(req)}`, limit: 5, windowSec: 60 });
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } });
  }

  const url = new URL(req.url);
  const port = Number(url.searchParams.get("port") ?? "");
  const csrf = url.searchParams.get("csrf") ?? "";
  const dailyCapUsd = Number(url.searchParams.get("cap") ?? "");
  const name = (url.searchParams.get("name") ?? "").slice(0, 60) || null;

  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return NextResponse.json({ error: "bad port" }, { status: 400 });
  }
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(csrf)) {
    return NextResponse.json({ error: "bad csrf" }, { status: 400 });
  }
  if (!Number.isFinite(dailyCapUsd) || dailyCapUsd <= 0 || dailyCapUsd > 100_000) {
    return NextResponse.json({ error: "cap must be a positive USD amount (max 100000)" }, { status: 400 });
  }

  // Server-generated ephemeral key (custodial). 32-byte seed → keypair.
  const seed = randomBytes(32);
  const kp = Ed25519Keypair.fromSecretKey(new Uint8Array(seed));
  const ephemeralSecretB64 = toBase64(seed);
  const ephemeralPubKey = toBase64(kp.getPublicKey().toRawBytes());

  let maxEpoch: number;
  try {
    maxEpoch = (await getCurrentEpoch()) + MAX_EPOCH_HORIZON;
    if (!Number.isFinite(maxEpoch) || maxEpoch <= 0) throw new Error("invalid epoch");
  } catch (err) {
    return NextResponse.json({ error: "Could not read current Sui epoch: " + (err as Error).message }, { status: 502 });
  }

  const randomness = BigInt("0x" + randomBytes(16).toString("hex")).toString();
  const zkNonce = generateNonce(kp.getPublicKey(), maxEpoch, randomness);

  const rawState = randomBytes(18).toString("base64url");
  const state = `agw.${port}.${csrf}.${rawState}`;

  // The binding carries the SECRET (custodial) + cap + name to the callback,
  // signed + httpOnly + 5-min TTL, then encrypted at rest in agent_wallets.
  const binding = sign(
    Buffer.from(
      JSON.stringify({ ephemeralPubKey, ephemeralSecretB64, maxEpoch, randomness, rawState, dailyCapUsd, name }),
    ).toString("base64url"),
  );

  await setStateCookie(state);
  const jar = await cookies();
  jar.set(AGENT_BINDING_COOKIE, binding, {
    httpOnly: true,
    domain: cookieDomain(),
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 300,
  });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return NextResponse.json({ error: "oauth not configured" }, { status: 500 });
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
