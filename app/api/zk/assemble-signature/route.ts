import { NextResponse } from "next/server";
import {
  readEntryIdFromRequest,
  mobileSigningContext,
  isMobileRequest,
} from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { rateLimitAsync } from "@/lib/rate-limit";
import {
  assembleZkLoginSignature,
  readSigningCookie,
  type CachedZkProof,
} from "@/lib/zksigner";
import { requireAppAttestStructural } from "@/lib/app-attest";

export const runtime = "nodejs";

/**
 * POST /api/zk/assemble-signature
 *
 * Pure proof-assembly endpoint. Factored out of `/api/send/gasless-submit`
 * so iOS can broadcast directly to a Sui fullnode and skip the Vercel hop
 * on the slow leg. This endpoint NEVER touches the chain, it only takes
 * the user's ephemeral signature + (optional) cached zk proof and returns
 * the full zkLogin signature ready to attach to `executeTransactionBlock`.
 *
 * Cache hit (cachedProof supplied + still valid): ~50ms.
 * Cache miss (fresh prover round-trip via Shinami): ~500ms-3s.
 *
 * Auth/App-Attest gate matches the canonical `gasless-submit` route, the
 * pair is fungible from a security standpoint, the only difference is who
 * broadcasts the bytes.
 */
export async function POST(req: Request) {
  const attestBlock = requireAppAttestStructural(req);
  if (attestBlock) return attestBlock;

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // The header above claims this route's gate "matches the canonical
  // gasless-submit route". It did not: gasless-submit applies
  // denyUnlessAppApproved + a per-user rate limit, and this route applied
  // neither, so a signed-in-but-unapproved account could obtain a
  // broadcast-ready zkLogin signature here and skip the beta guardrail
  // entirely. The rate limit also bounds prover cost (each cache miss is a
  // paid Shinami round-trip). Mirrors gasless-submit exactly.
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  const rl = await rateLimitAsync({
    key: `zk-assemble:user:${userId}`,
    limit: 30,
    windowSec: 3600,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const signing = isMobileRequest(req)
    ? await mobileSigningContext(userId)
    : await readSigningCookie();
  if (!signing) {
    return NextResponse.json({ error: "No active sign-in" }, { status: 401 });
  }

  let body: {
    bytesB64?: string;
    ephemeralPubKeyB64?: string;
    maxEpoch?: number;
    randomness?: string;
    userSignature?: string;
    cachedProof?: CachedZkProof;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (
    !body.bytesB64 ||
    !body.ephemeralPubKeyB64 ||
    body.maxEpoch == null ||
    !body.randomness ||
    !body.userSignature
  ) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }

  try {
    const t0 = Date.now();
    const { signature, proof, isFresh } = await assembleZkLoginSignature({
      ephemeralPubKeyB64: body.ephemeralPubKeyB64,
      maxEpoch: body.maxEpoch,
      randomness: body.randomness,
      userSignature: body.userSignature,
      cachedProof: body.cachedProof,
      jwt: signing.jwt,
      salt: signing.salt,
    });
    const proofMs = Date.now() - t0;

    console.log(
      `[zk/assemble-signature] user=${userId} proof=${proofMs}ms (${isFresh ? "FRESH" : "CACHED"})`
    );

    return NextResponse.json({
      signature,
      // Echo the freshly-minted proof so iOS can re-cache and skip the
      // prover on the next send. On cache hit `isFresh=false` and we
      // omit the field (iOS already has it).
      freshProof: isFresh ? proof : undefined,
      proofMs,
    });
  } catch (err) {
    const msg = (err as Error).message ?? "assemble failed";
    console.warn(`[zk/assemble-signature] user=${userId} failed: ${msg}`);
    const status = msg.includes("No active sign-in") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
