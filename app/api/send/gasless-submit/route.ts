import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import {
  readEntryIdFromRequest,
  mobileSigningContext,
  isMobileRequest,
} from "@/lib/mobile-sessions";
import { userById, enqueueRoundup } from "@/lib/db";
import { assembleZkLoginSignature, readSigningCookie } from "@/lib/zksigner";
import { sui } from "@/lib/sui";
import { fromBase64 } from "@mysten/sui/utils";
import { awardForTx, type EarnTrigger } from "@/lib/rewards/earn";
import { requireAppAttestStructural } from "@/lib/app-attest";
import { takePendingRoundup, takePendingInbound } from "@/lib/perf-cache";
import { notifyInboundSettlement } from "@/lib/notify";
import { rateLimitAsync } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * POST /api/send/gasless-submit
 *
 * Plain USDsui sends use Sui's gasless stablecoin path:
 * `0x2::coin::send_funds<T>` with `gasPrice=0` and no gas owner.
 * No Onara round-trip — we just assemble the user's zkLogin signature
 * and broadcast directly to the fullnode.
 *
 * Mirrors `/api/zk/sponsor-execute` for everything except the gas /
 * broadcast path. Rewards crediting + proof caching behave the same.
 */
export async function POST(req: Request) {
  const attestBlock = requireAppAttestStructural(req);
  if (attestBlock) return attestBlock;

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // Gate reads run CONCURRENTLY — app-access, rate limit and the user row
  // are independent lookups; serial they stacked 3 DB round-trips on the
  // submit critical path. Denial precedence is unchanged.
  const [denied, rl, user] = await Promise.all([
    // Private-beta guardrail: signed-in is not enough — the account must be
    // on the app allowlist before it can originate any value-moving call.
    denyUnlessAppApproved(userId),
    // Per-user global rate limit on this money route (anti-abuse / anti-DDoS).
    rateLimitAsync({ key: `gasless-submit:user:${userId}`, limit: 30, windowSec: 3600 }),
    userById(userId),
  ]);
  if (denied) return denied;
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }
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
    cachedProof?: import("@/lib/zksigner").CachedZkProof;
    meta?: { kind?: string; amountUsd?: number; venue?: string };
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
    const assemble = (useCachedProof: boolean) =>
      assembleZkLoginSignature({
        ephemeralPubKeyB64: body.ephemeralPubKeyB64!,
        maxEpoch: body.maxEpoch!,
        randomness: body.randomness!,
        userSignature: body.userSignature!,
        cachedProof: useCachedProof ? body.cachedProof : undefined,
        jwt: signing.jwt,
        salt: signing.salt,
      });
    let assembled = await assemble(true);
    const tProof = Date.now();

    // Submit directly to the fullnode. Gasless txs need only the
    // user's zkLogin signature — no sponsor signature involved. The
    // gRPC client auto-detects gasless eligibility, so no extra flag
    // needed here (prepare already set gasPrice=0 on the build).
    const submit = (sig: string) =>
      sui().executeTransaction({
        transaction: fromBase64(body.bytesB64!),
        signatures: [sig],
      }) as Promise<Record<string, unknown>>;

    let result: Record<string, unknown>;
    try {
      result = await submit(assembled.signature);
    } catch (err) {
      // Stale client proof (cached proof minted against a previous
      // ephemeral key) → "Groth16 proof verify failed" at the node.
      // Re-mint fresh from the server-held jwt+salt and retry once —
      // mirrors zk/sponsor-execute's recovery.
      const m = ((err as Error)?.message ?? "").toLowerCase();
      const staleProof =
        m.includes("groth16") ||
        m.includes("invalid user signature") ||
        m.includes("signature is not valid");
      if (!assembled.isFresh && body.cachedProof && staleProof) {
        console.warn(
          `[send/gasless-submit] stale cached proof rejected on-chain (user=${userId}) — re-minting fresh and retrying once`
        );
        assembled = await assemble(false);
        result = await submit(assembled.signature);
      } else {
        throw err;
      }
    }
    const { proof, isFresh } = assembled;
    const tDone = Date.now();

    console.log(
      `[send/gasless-submit] proof=${tProof - t0}ms (${isFresh ? "FRESH" : "CACHED"}) · broadcast=${tDone - tProof}ms · total=${tDone - t0}ms`
    );

    // Same discriminated-union shape Onara returns:
    //   { $kind: "Transaction",       Transaction:       { digest, ... } }
    //   { $kind: "FailedTransaction", FailedTransaction: { digest, ... } }
    const okTx = result.Transaction as { digest?: string } | undefined;
    const failedTx = result.FailedTransaction as { digest?: string } | undefined;
    // MONEY-SAFETY: a Move-ABORT comes back as FailedTransaction WITH a digest —
    // never report it as a delivered send (no funds moved).
    if ((result.$kind as string | undefined) === "FailedTransaction" || (failedTx && !okTx)) {
      console.error("[send/gasless-submit] FAILED on-chain tx:", JSON.stringify(failedTx ?? result));
      return NextResponse.json(
        { error: "transaction failed on chain (aborted) — funds not moved", code: "TX_ABORTED" },
        { status: 502 }
      );
    }
    const digest = (result.digest as string | undefined) ?? okTx?.digest ?? "";
    if (!digest) {
      console.error("[send/gasless-submit] no digest in response:", result);
      return NextResponse.json(
        { error: "no digest in broadcast response" },
        { status: 500 }
      );
    }

    // Deferred Spend-and-Save — fire-and-forget. The gasless rail
    // can't co-bundle the NAVI supply (PTB allowlist), so
    // sponsor-prepare stashed the rounded-up USDsui amount under
    // this user; we now hand it to the `roundup_queue` for the cron
    // worker to drain. Done AFTER we have a confirmed digest so we
    // never enqueue a save that didn't actually accompany a send.
    //
    // Two layers of detachment intentionally:
    //   1. `takePendingRoundup` is synchronous (in-memory map).
    //   2. `enqueueRoundup` is awaited inside a void-returning IIFE so
    //      the response isn't gated on the DB write — a queue insert
    //      failure must not surface as a failed send.
    const pendingRoundupUsd = takePendingRoundup(userId);
    if (pendingRoundupUsd && pendingRoundupUsd > 0) {
      void (async () => {
        try {
          await enqueueRoundup({ userId, amountUsd: pendingRoundupUsd });
        } catch (e) {
          console.warn(
            `[send/gasless-submit] enqueueRoundup failed (user=${userId}, amount=${pendingRoundupUsd}):`,
            (e as Error).message
          );
        }
      })();
    }

    // Notify the recipient that money landed (email now; push once APNs is
    // wired). Fire-and-forget — never gates the response, never throws.
    const inbound = takePendingInbound(userId);
    if (inbound) {
      void notifyInboundSettlement({
        recipientAddress: inbound.to,
        amountUsd: inbound.amountUsd,
        senderName: inbound.senderName,
      });
    }

    // Rewards earn — fire-and-forget, same shape as sponsor-execute.
    const meta = body.meta;
    if (
      meta &&
      typeof meta.kind === "string" &&
      typeof meta.amountUsd === "number" &&
      meta.amountUsd > 0
    ) {
      const ALLOWED: ReadonlySet<EarnTrigger> = new Set([
        "send",
        "invest",
        "withdraw",
        "roundup",
        "goal",
      ]);
      const trigger = meta.kind as EarnTrigger;
      if (ALLOWED.has(trigger)) {
        const amountUsd = Math.min(meta.amountUsd, 10_000);
        awardForTx({
          userId,
          trigger,
          amountUsd,
          digest,
          venue: meta.venue,
        }).catch((e) =>
          console.warn("[send/gasless-submit] awardForTx failed:", e)
        );
      }
    }

    return NextResponse.json({
      digest,
      // Echo the proof iOS sent (or the one we minted) so iOS can
      // re-cache and skip the prover on the next send.
      freshProof: isFresh ? proof : undefined,
    });
  } catch (err) {
    const msg = (err as Error).message ?? "submit failed";
    console.warn(`[send/gasless-submit] user=${userId} failed: ${msg}`);
    // A fresh proof mint failing with "Invalid params" (-32602) means the
    // JWT can no longer prove (expired id_token / nonce mismatch) — a
    // session problem: route the client to a clean re-sign-in.
    if (/-32602|invalid params/i.test(msg)) {
      return NextResponse.json(
        {
          error: "Sign in again — your session needs a refresh.",
          code: "session_rebind_required",
        },
        { status: 401 }
      );
    }
    const status = msg.includes("No active sign-in") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
