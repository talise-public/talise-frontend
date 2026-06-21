import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import {
  readEntryIdFromRequest,
  mobileSigningContext,
  isMobileRequest,
} from "@/lib/mobile-sessions";
import { db, userById } from "@/lib/db";
import { assembleZkLoginSignature, readSigningCookie } from "@/lib/zksigner";
import { onara } from "@/lib/onara";
import { awardForTx, type EarnTrigger } from "@/lib/rewards/earn";
import { requireAppAttestStructural } from "@/lib/app-attest";
import { rateLimitAsync } from "@/lib/rate-limit";
import { recordSendLatency, takePendingInbound } from "@/lib/perf-cache";
import { notifyInboundSettlement } from "@/lib/notify";

export const runtime = "nodejs";

/**
 * Per-leg timeout wrapper that THROWS on timeout (unlike the
 * fallback-returning variant in lib/activity.ts / earn/withdraw/prepare).
 *
 * Why throw? sponsor-execute moves money. A silent fallback on the proof
 * mint or Onara POST would either drop the send (false failure) or, worse,
 * return a fake success without a digest (false success — exactly what we
 * fixed in e50a2b4). So this variant rejects with a typed error and lets
 * the outer try/catch translate it into a 5xx with a stable `code`.
 *
 * Tags `err.code = code` so the outer handler can map it to the right
 * HTTP status (504 PROOF_TIMEOUT / ONARA_TIMEOUT / ROUTE_TIMEOUT,
 * 502 PROOF_FAILED).
 */
function withLegTimeout<T>(
  p: Promise<T>,
  ms: number,
  leg: string,
  code: string
): Promise<T> {
  const start = Date.now();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const elapsed = Date.now() - start;
      console.warn(
        `[zk/sponsor-execute] ${leg} timed out after ${elapsed}ms (cap=${ms}ms)`
      );
      const err = new Error(`${leg} timed out after ${elapsed}ms`) as Error & {
        code?: string;
        leg?: string;
        timedOut?: boolean;
      };
      err.code = code;
      err.leg = leg;
      err.timedOut = true;
      reject(err);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        // Preserve the original error but tag it with the leg so the
        // outer handler can attach a stable code on rethrow.
        if (e && typeof e === "object" && !(e as { leg?: string }).leg) {
          (e as { leg?: string }).leg = leg;
        }
        reject(e as Error);
      }
    );
  });
}

/**
 * POST /api/zk/sponsor-execute
 *
 * Trip 2. The user has signed the sponsored TransactionData bytes with their
 * ephemeral key. We:
 *   1. Wrap that ephemeral signature into a zkLoginSignature (sender sig).
 *   2. POST { sender, txBytes, txSignature } to Onara's /sponsor endpoint —
 *      Onara enforces its policy, signs as gasOwner, broadcasts, and returns
 *      the execution result.
 *
 * Onara handles: policy enforcement, gasOwner signing, broadcast, retries.
 * We never see the sponsor private key from the web tier.
 */
export async function POST(req: Request) {
  // P1-5: mobile traffic must carry an App Attest assertion on
  // money-moving routes. Web cookie sessions fall through.
  const attestBlock = requireAppAttestStructural(req);
  if (attestBlock) return attestBlock;

  const onaraUrl = process.env.ONARA_URL;
  if (!onaraUrl) {
    return NextResponse.json(
      { error: "ONARA_URL not configured" },
      { status: 503 }
    );
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // Gate reads run CONCURRENTLY — app-access, rate limit and the user row
  // are independent lookups; serial they stacked 3 DB round-trips on the
  // execute critical path. Denial precedence is unchanged.
  const [denied, rl, user] = await Promise.all([
    // Private-beta guardrail: signed-in is not enough — the account must be
    // on the app allowlist before it can originate any value-moving call.
    denyUnlessAppApproved(userId),
    // Rate-limit: 30 sponsored executions per hour per user. Money-moving
    // route. Keyed on userId ALONE (F7): mixing in a client-controllable IP
    // (x-forwarded-for) let an attacker rotate buckets to blow past the cap.
    // Uses the GLOBAL Upstash limiter (F6) so the cap holds across all
    // serverless instances, not per-lambda (falls back to in-memory if Redis
    // is unset).
    rateLimitAsync({
      key: `zk-sponsor-execute:user:${userId}`,
      limit: 30,
      windowSec: 3600,
    }),
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

  // Mobile callers don't have a signing cookie — pull jwt+salt from the
  // mobile_sessions row instead. Web callers stay on the cookie path.
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
    /**
     * Optional. If the client has a cached zk proof from a previous sign in
     * this session, pass it here to skip the 2-4s Shinami round trip.
     */
    cachedProof?: import("@/lib/zksigner").CachedZkProof;
    /**
     * Optional rewards-accounting hint from iOS. The PTB it just signed
     * was minted by one of our prepare routes, so iOS knows whether
     * this was a send / invest / withdraw and how many USD it moved.
     * Server validates `kind` against a closed enum + clips `amountUsd`
     * before crediting — a malicious client can at worst inflate their
     * own points balance, never anyone else's money.
     */
    meta?: {
      // `consolidate` is the one-time "Enable gasless balance" tap that
      // burns the user's Coin<USDsui> objects into their accumulator.
      // The kind is accepted here so the request validates, but the
      // ALLOWED earn-trigger set below does NOT include it — we don't
      // credit points for a wallet-setup operation.
      kind?:
        | "send"
        | "invest"
        | "withdraw"
        | "roundup"
        | "goal"
        | "consolidate"
        | "retarget";
      amountUsd?: number;
      venue?: string;
      /**
       * Round-up & Save (Phase 2 v2). When a send PTB includes a
       * compound NAVI supply leg for auto-save, iOS forwards the
       * server-blessed round-up amount from the prepare response. We
       * credit a second `roundup` earn on top of the send's points
       * + bump `users.roundup_saved_usd` to reflect the on-chain
       * supply that just landed atomically with the send.
       */
      roundupUsd?: number;
    };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (
    !body.bytesB64 ||
    !body.ephemeralPubKeyB64 ||
    !body.userSignature ||
    !body.randomness ||
    typeof body.maxEpoch !== "number"
  ) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }

  // Mobile callers: ALWAYS prefer the (ephPubKey, maxEpoch,
  // randomness) values stored at sign-in time. The JWT's nonce was
  // Poseidon-hashed from those values, so the prover only accepts
  // proofs minted against them.
  const bound = isMobileRequest(req)
    ? (signing as unknown as {
        ephemeralPubKeyB64: string | null;
        maxEpoch: number | null;
        randomness: string | null;
      })
    : null;

  // Sessions minted before the Poseidon-nonce fix (commit 6f0a919)
  // have NULL binding columns. Their JWT's nonce is just random
  // bytes, so any proof mint will -32602. Force a re-sign-in
  // instead of trying anyway and surfacing an opaque Shinami error.
  if (isMobileRequest(req)) {
    if (
      !bound?.ephemeralPubKeyB64 ||
      bound.maxEpoch == null ||
      !bound.randomness
    ) {
      return NextResponse.json(
        {
          error: "Sign in again — your session predates the latest fix.",
          code: "session_rebind_required",
        },
        { status: 401 }
      );
    }
  }

  const ephemeralPubKeyB64 = bound?.ephemeralPubKeyB64 ?? body.ephemeralPubKeyB64;
  const maxEpochToUse = bound?.maxEpoch ?? body.maxEpoch;
  const randomnessToUse = bound?.randomness ?? body.randomness;

  // Pin to non-undefined locals — TS doesn't carry the validation-block
  // narrowing of `body.*` through the IIFE closure below.
  const bytesB64 = body.bytesB64;
  const userSignature = body.userSignature;

  // Outer route cap. iOS used to hit URLSession's 60s default before
  // anything in here could fall over cleanly. We promise-race the whole
  // pipeline against 25s so we ALWAYS surface a JSON error before iOS
  // gives up — request-timeout on the client is now 30s, this fires first.
  const ROUTE_CAP_MS = 25_000;
  let outerTimer: ReturnType<typeof setTimeout> | undefined;
  const routeDeadline = new Promise<never>((_, reject) => {
    outerTimer = setTimeout(() => {
      const err = new Error("sponsor-execute deadline exceeded") as Error & {
        code?: string;
        timedOut?: boolean;
      };
      err.code = "ROUTE_TIMEOUT";
      err.timedOut = true;
      reject(err);
    }, ROUTE_CAP_MS);
  });

  // On-chain zkLogin signature rejection signature. Seen when the CLIENT's
  // cached proof was minted for a different ephemeral key / randomness than
  // the one that just signed (e.g. a stale ProofCache surviving a re-sign-in
  // on iOS): "Invalid user signature: Signature is not valid: General
  // cryptographic error: Groth16 proof verify failed".
  const isStaleProofError = (err: unknown): boolean => {
    const m = ((err as Error)?.message ?? "").toLowerCase();
    return (
      m.includes("groth16") ||
      m.includes("invalid user signature") ||
      m.includes("signature is not valid")
    );
  };

  const work = (async () => {
    const t0 = Date.now();
    // Proof mint: cached path ~250ms, fresh Shinami ~2-4s, fresh GPU
    // ~400ms. 12s ceiling is 3x the worst hot path — anything beyond
    // means Shinami/GPU is wedged and we should fail fast.
    const assemble = (useCachedProof: boolean) =>
      withLegTimeout(
        assembleZkLoginSignature({
          ephemeralPubKeyB64,
          maxEpoch: maxEpochToUse,
          randomness: randomnessToUse,
          userSignature: userSignature,
          cachedProof: useCachedProof ? body.cachedProof : undefined,
          jwt: signing.jwt,
          salt: signing.salt,
        }),
        12_000,
        "proof",
        "PROOF_TIMEOUT"
      );
    let assembled = await assemble(true);
    const tProof = Date.now();
    // Tag the freshness with the prover backend so we can grep
    // "FRESH-GPU" vs "FRESH-SHINAMI" vs "FRESH-CANARY" in production
    // logs. Confirms ZK_PROVER_PRIMARY routing is actually winning —
    // critical signal during the GPU cutover.
    const freshTagFor = (a: typeof assembled) =>
      a.isFresh
        ? a.source
          ? `FRESH-${a.source.canary ? "CANARY-" : ""}${a.source.backend.toUpperCase()}${
              a.source.role === "fallback" ? "-FALLBACK" : ""
            }`
          : "FRESH"
        : "CACHED";

    const onaraClient = onara();
    // Optimistic broadcast: return the digest as soon as Onara ACKs
    // receipt instead of waiting for the chain to include the tx.
    // Sui finalizes in ~600ms regardless; this lets the user's UI
    // advance immediately. Trade-off: if the tx fails on chain (rare
    // — only on malformed PTB or balance race), we don't surface that
    // here. iOS resolves the actual outcome by polling the digest
    // (HomeView's optimistic-balance path already does this).
    //
    // Onara OWNS the timeout — we must not sever it early. Onara self-bounds at
    // 45s execution / 30s confirmation (onara/api app.ts), so it always returns
    // a DEFINITIVE result (a digest the instant the tx broadcasts, or a clean
    // error) within the ~60s iOS URLSession ceiling. The old 8s cap aborted the
    // HTTP request mid-broadcast and surfaced "onara timeout after 8003ms / Send
    // failed, no funds moved" even when Onara had ALREADY accepted the tx — the
    // canonical Onara SDK imposes no client timeout for exactly this reason. This
    // cap is now only a true-hang backstop: above Onara's own budget, below the
    // iOS ceiling. Env-tunable via ONARA_SPONSOR_TIMEOUT_MS.
    const onaraCapMs = Number(process.env.ONARA_SPONSOR_TIMEOUT_MS) || 50_000;
    const broadcast = (sig: string) =>
      withLegTimeout(
        onaraClient.sponsor({
          sender: user.sui_address,
          txBytes: bytesB64,
          txSignature: sig,
          waitForExecution: false,
          // Skip Onara's pre-broadcast simulate — one fewer RPC round-trip on
          // the hot send path. The send is already optimistic (we don't wait
          // for execution; iOS polls the digest), so the simulate only added
          // latency + a timeout surface under RPC congestion.
          simulate: false,
          timeoutMs: onaraCapMs,
        }),
        onaraCapMs,
        "onara",
        "ONARA_TIMEOUT"
      ) as Promise<Record<string, unknown>>;

    let result: Record<string, unknown>;
    try {
      result = await broadcast(assembled.signature);
    } catch (err) {
      // Stale client proof: the cached proof was minted against a previous
      // ephemeral key, so the chain rejects the assembled signature with a
      // Groth16 verify failure. The server holds the jwt+salt — re-mint a
      // FRESH proof and retry ONCE instead of dead-ending the send (the
      // response's freshProof then replaces the client's stale cache). If
      // the JWT itself is too old to prove, the mint throws and the proof-
      // leg error mapping below converts it to session_rebind_required.
      if (!assembled.isFresh && body.cachedProof && isStaleProofError(err)) {
        console.warn(
          `[zk/sponsor-execute] stale cached proof rejected on-chain (user=${userId}) — re-minting fresh and retrying once`
        );
        assembled = await assemble(false);
        result = await broadcast(assembled.signature);
      } else {
        throw err;
      }
    }
    const { signature: zkLoginSignature, proof, isFresh } = assembled;
    void zkLoginSignature; // consumed by broadcast above; kept for shape parity
    const tDone = Date.now();

    // Per-leg timing so we can see exactly where the latency goes.
    // Logged on EVERY successful response (defense in depth) — grep
    // `[zk/sponsor-execute]` to see proof/onara/total breakdown.
    console.log(
      `[zk/sponsor-execute] proof=${tProof - t0}ms (${freshTagFor(assembled)}) · onara=${tDone - tProof}ms · total=${tDone - t0}ms`
    );
    recordSendLatency({
      leg: "execute",
      totalMs: tDone - t0,
      atMs: Date.now(),
      extras: {
        proofMs: tProof - t0,
        onaraMs: tDone - tProof,
        proverSource: freshTagFor(assembled),
        proverBackend: assembled.source?.backend,
        proverRole: assembled.source?.role,
        proverCanary: assembled.source?.canary,
      },
    });

    // Rewards earn — fire-and-forget. The user's money already moved;
    // if the points write fails (DB hiccup, etc.) we don't block the
    // response. Validation here is server-side: only the closed kind
    // enum, only positive amounts up to a per-tx cap (defends against
    // a malicious client inflating their own points balance — at worst
    // a single tx earns the cap, never more).
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
        "swap",
      ]);
      const trigger = meta.kind as EarnTrigger;
      if (ALLOWED.has(trigger)) {
        // 10k USD per-tx cap on the points-earning amount. Real txs
        // can exceed this — the user just doesn't farm extra points
        // beyond it.
        const amountUsd = Math.min(meta.amountUsd, 10_000);
        // Don't await — we'll return to iOS as soon as we have the
        // digest. The .catch() prevents an unhandled promise rejection
        // from crashing the request handler.
        awardForTx({
          userId,
          trigger,
          amountUsd,
          digest: undefined, // filled below once we extract it
          venue: meta.venue,
        }).catch((e) =>
          console.warn("[zk/sponsor-execute] awardForTx failed:", e)
        );
      }
    }

    // Onara returns the raw gRPC `TransactionResult` from its
    // executeTransaction — a discriminated union shaped like:
    //   { $kind: 'Transaction',       Transaction:       { digest, effects, ... } }
    //   { $kind: 'FailedTransaction', FailedTransaction: { digest, ... } }
    // So `result.digest` is undefined; the digest is one level deeper.
    // Fall through several known shapes for resilience to upstream
    // changes — we'd rather extract a digest than fail the send over
    // a field-name diff.
    const r = result as Record<string, unknown>;
    const okTx =
      (r.Transaction as { digest?: string; effects?: unknown } | undefined) ??
      (r.transaction as { digest?: string; effects?: unknown } | undefined);
    const failedTx = r.FailedTransaction as { digest?: string } | undefined;

    // MONEY-SAFETY: a tx that is ADMITTED then Move-ABORTS comes back as a
    // FailedTransaction that STILL carries a digest. Never report that as a
    // delivered send — the recipient was not paid and the balance must not drop.
    if ((r.$kind as string | undefined) === "FailedTransaction" || (failedTx && !okTx)) {
      console.error(
        `[zk/sponsor-execute] FAILED on-chain tx user=${userId} digest=${failedTx?.digest ?? ""}`,
        JSON.stringify(failedTx ?? r)
      );
      return NextResponse.json(
        { error: "transaction failed on chain (aborted) — funds not moved", code: "TX_ABORTED" },
        { status: 502 }
      );
    }

    const digest = (r.digest as string | undefined) ?? okTx?.digest ?? "";
    if (!digest) {
      // Log the raw shape so we can fix the extractor without guessing.
      console.error(
        "[zk/sponsor-execute] no digest in Onara response — shape:",
        JSON.stringify(Object.keys(r))
      );
    }

    // Phase 2 v2 — Round-up & Save credit on the COMPOUND PTB.
    //
    // The send PTB now includes a NAVI supply leg for `meta.roundupUsd`
    // (computed + appended by /api/send/prepare based on the user's
    // round-up config). It already settled atomically with the send
    // when Onara broadcast — funds are in the NAVI pool. All that's
    // left is the bookkeeping: credit the 5pt/$1 round-up earn, bump
    // lifetime saved tallies (both `lifetime_saved_usd` and the
    // running `roundup_saved_usd` for the RoundupCard UI).
    //
    // Trust the server-blessed `meta.roundupUsd` from prepare: the
    // user signed exactly that amount into the on-chain supply, so
    // crediting any other value would diverge from chain reality. A
    // malicious client that LIES about roundupUsd > 0 when no supply
    // ran will fail Sui validation at sponsor-time (the PTB doesn't
    // match what they're claiming) — so by the time we reach this
    // point the value is implicitly verified.
    // Notify the RECIPIENT that money landed. The stash was set in
    // sponsor-prepare; previously only gasless-submit consumed it, so
    // SPONSORED sends (Spend+Save round-ups, cross-currency, any Move-call
    // send) settled without ever notifying the recipient. Consume it here too
    // so every inbound send pushes. Fire-and-forget — never gates the
    // response, never throws (same contract as gasless-submit).
    if (digest) {
      const inbound = takePendingInbound(userId);
      if (inbound) {
        void notifyInboundSettlement({
          recipientAddress: inbound.to,
          amountUsd: inbound.amountUsd,
          senderName: inbound.senderName,
        });
      }
    }

    const roundupUsd = meta?.roundupUsd ?? 0;
    if (digest && roundupUsd > 0 && meta?.kind === "send") {
      const cappedRoundup = Math.min(roundupUsd, 10_000);
      awardForTx({
        userId,
        trigger: "roundup",
        amountUsd: cappedRoundup,
        digest,
        venue: "navi",
      })
        .then(() =>
          // awardForTx bumps lifetime_saved_usd; we additionally bump
          // the dedicated roundup_saved_usd column the RoundupCard
          // reads so that running total is in sync. One extra UPDATE.
          db().execute({
            sql: "UPDATE users SET roundup_saved_usd = COALESCE(roundup_saved_usd, 0) + ? WHERE id = ?",
            args: [cappedRoundup, userId],
          })
        )
        .catch((e) =>
          console.warn("[zk/sponsor-execute] roundup credit failed:", e)
        );
    }

    return NextResponse.json({
      digest,
      effects:
        (r.effects as unknown) ??
        (okTx?.effects as unknown) ??
        null,
      objectChanges:
        ((r.objectChanges as unknown[]) ?? []) as unknown[],
      freshProof: isFresh ? proof : undefined,
    });
  })();

  try {
    const response = await Promise.race([work, routeDeadline]);
    if (outerTimer) clearTimeout(outerTimer);
    return response as NextResponse;
  } catch (err) {
    if (outerTimer) clearTimeout(outerTimer);
    const e = err as Error & { code?: string; leg?: string; timedOut?: boolean };
    const msg = e.message ?? "execute failed";

    // Hard deadline tripped before any leg could fail cleanly. Shouldn't
    // happen in practice (each leg has its own shorter cap) — surfacing
    // it distinctly so we'd notice in logs.
    if (e.code === "ROUTE_TIMEOUT") {
      console.error("[zk/sponsor-execute] route deadline exceeded");
      return NextResponse.json(
        { error: "Send timed out. Please try again.", code: "ROUTE_TIMEOUT" },
        { status: 504 }
      );
    }

    // Proof mint took too long — almost always Shinami congestion or a
    // GPU box that's degraded. iOS shows the user a real error; we
    // don't poison the cache or fake success.
    if (e.code === "PROOF_TIMEOUT") {
      return NextResponse.json(
        { error: "Proof mint took too long, try again", code: "PROOF_TIMEOUT" },
        { status: 504 }
      );
    }

    // Onara wouldn't respond within 8s. Likely Onara upstream blip; the
    // tx never went on chain, so a retry is safe.
    if (e.code === "ONARA_TIMEOUT" || e.leg === "onara") {
      const onaraErr = msg.includes("onara") ? msg : `onara: ${msg}`;
      return NextResponse.json(
        { error: onaraErr, code: e.code ?? "ONARA_FAILED" },
        { status: 504 }
      );
    }

    // Proof mint threw. An "Invalid params" (-32602) from the prover means
    // the JWT can no longer mint a proof (expired id_token / nonce-binding
    // mismatch) — that's a SESSION problem, not a prover outage: route the
    // client to a clean re-sign-in instead of an opaque 502 it would retry
    // forever (the iOS money flows all handle session_rebind_required).
    if (e.leg === "proof") {
      if (/-32602|invalid params/i.test(msg)) {
        return NextResponse.json(
          {
            error: "Sign in again — your session needs a refresh.",
            code: "session_rebind_required",
          },
          { status: 401 }
        );
      }
      // Network glitch, Shinami 5xx, GPU down. The zksigner already
      // exhausted its primary→fallback chain — we're out of options for
      // this request. 502 distinguishes from timeout.
      return NextResponse.json(
        { error: msg, code: "PROOF_FAILED" },
        { status: 502 }
      );
    }

    const status = msg.includes("No active sign-in") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
