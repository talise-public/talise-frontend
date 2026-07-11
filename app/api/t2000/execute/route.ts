import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readSessionEntryId } from "@/lib/session";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import {
  callProverWithFallback,
  readSigningCookie,
} from "@/lib/zksigner";
import { decodeJwt } from "@/lib/zklogin";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromBase64 } from "@mysten/sui/utils";
import {
  genAddressSeed,
  getExtendedEphemeralPublicKey,
} from "@mysten/sui/zklogin";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { getT2000 } from "@/lib/t2000";
import type { ZkLoginProof } from "@t2000/sdk";

export const runtime = "nodejs";

/**
 * POST /api/t2000/execute
 *
 * Runs an agentic-finance op via `@t2000/sdk` (NAVI lending + Cetus
 * aggregator). The SDK builds the PTB internally, signs with a zkLogin
 * signer, and broadcasts — we just hydrate the signer from the user's
 * session and forward the call.
 *
 * Client must POST the ephemeral PRIVATE key (bech32 `suiprivkey1…`) so we
 * can rebuild the zkLogin signer here. The ephemeral key is a one-shot
 * 55-minute artifact — security tradeoff documented in WEB_ARCHITECTURE.md.
 * For a stricter setup, run the SDK browser-side via `@t2000/sdk/browser`.
 */
export async function POST(req: Request) {
  const userId = await readSessionEntryId();
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // Private-beta guardrail: signed-in is not enough — the account must be on
  // the app allowlist before it can originate any value-moving call.
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  // Per-user global rate limit on this money route (anti-abuse / anti-DDoS).
  const rl = await rateLimitAsync({ key: `t2000-execute:user:${userId}`, limit: 30, windowSec: 3600 });
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

  const signing = await readSigningCookie();
  if (!signing) {
    return NextResponse.json({ error: "No active sign-in" }, { status: 401 });
  }

  type Body = {
    op?:
      | "save"
      | "swap"
      | "withdraw"
      | "borrow"
      | "repay"
      | "stakeVSui"
      | "claimRewards";
    amount?: number;
    asset?: string;
    from?: string;
    to?: string;
    ephemeralPrivateKey?: string;
    ephemeralPubKeyB64?: string;
    maxEpoch?: number;
    randomness?: string;
    /** Optional cached zk proof — skips the 2-4s Shinami round trip. */
    cachedProof?: ZkLoginProof;
  };
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  // claimRewards is the only op that doesn't take an amount.
  const amountRequired = body.op !== "claimRewards";
  if (
    !body.op ||
    (amountRequired && typeof body.amount !== "number") ||
    !body.ephemeralPrivateKey ||
    !body.ephemeralPubKeyB64 ||
    !body.randomness ||
    typeof body.maxEpoch !== "number"
  ) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }
  // F11: validate the money amount — `typeof === number` above still admits
  // NaN / Infinity / negative / absurd values that flow into the signing path.
  if (amountRequired) {
    const amt = body.amount as number;
    if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000_000) {
      return NextResponse.json(
        { error: "amount must be a positive, finite number" },
        { status: 400 }
      );
    }
  }

  try {
    const eph = Ed25519Keypair.fromSecretKey(body.ephemeralPrivateKey);

    // If the client cached the proof from an earlier signing this session,
    // skip Shinami entirely. Otherwise mint a fresh one and return it so
    // the client can store it for next time. `freshProof` in the response
    // signals "this was a cache miss, save me."
    let zkProof: ZkLoginProof;
    let isFresh = false;
    if (body.cachedProof) {
      zkProof = body.cachedProof;
    } else {
      const pubKey = new Ed25519PublicKey(fromBase64(body.ephemeralPubKeyB64));
      const extendedEphemeralPublicKey = getExtendedEphemeralPublicKey(pubKey);

      const claims = decodeJwt(signing.jwt);
      const addressSeed = genAddressSeed(
        BigInt(signing.salt),
        "sub",
        claims.sub,
        claims.aud
      ).toString();

      const { response: proof } = await callProverWithFallback({
        inputs: {
          jwt: signing.jwt,
          extendedEphemeralPublicKey,
          maxEpoch: body.maxEpoch,
          jwtRandomness: body.randomness,
          salt: signing.salt,
          keyClaimName: "sub",
        },
        canaryKey: addressSeed,
      });

      zkProof = { ...proof, addressSeed };
      isFresh = true;
    }

    const t2000 = getT2000({
      ephemeralKeypair: eph,
      zkProof,
      userAddress: user.sui_address,
      maxEpoch: body.maxEpoch,
    });

    const amount = body.amount ?? 0;
    type ExecResult = { digest?: string } & Record<string, unknown>;
    let result: ExecResult;

    switch (body.op) {
      case "save":
        result = (await t2000.save({
          amount,
          asset: (body.asset as never) ?? undefined,
        })) as unknown as ExecResult;
        break;
      case "claimRewards":
        result = (await t2000.claimRewards()) as unknown as ExecResult;
        break;
      case "swap":
        if (!body.from || !body.to) {
          return NextResponse.json(
            { error: "swap requires `from` and `to`" },
            { status: 400 }
          );
        }
        result = (await t2000.swap({
          from: body.from,
          to: body.to,
          amount,
        })) as unknown as ExecResult;
        break;
      case "withdraw":
        result = (await t2000.withdraw({
          amount,
          asset: (body.asset as never) ?? undefined,
        })) as unknown as ExecResult;
        break;
      case "borrow":
        result = (await t2000.borrow({
          amount,
          asset: (body.asset as never) ?? undefined,
        })) as unknown as ExecResult;
        break;
      case "repay":
        result = (await t2000.repay({
          amount,
          asset: (body.asset as never) ?? undefined,
        })) as unknown as ExecResult;
        break;
      case "stakeVSui":
        result = (await t2000.stakeVSui({ amount })) as unknown as ExecResult;
        break;
      default:
        return NextResponse.json(
          { error: `unknown op: ${body.op}` },
          { status: 400 }
        );
    }

    return NextResponse.json({
      digest: result.digest ?? "",
      result,
      // On cache miss we return the freshly-minted proof so the client can
      // reuse it next time — saves the 2-4s Shinami round trip.
      freshProof: isFresh ? zkProof : undefined,
    });
  } catch (err) {
    const msg = (err as Error).message ?? "execute failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
