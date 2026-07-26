import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import {
  readEntryIdFromRequest,
  mobileSigningContext,
  isMobileRequest,
} from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { assembleZkLoginSignature, readSigningCookie } from "@/lib/zksigner";
import { onara } from "@/lib/onara";
import { awardForTx, type EarnTrigger } from "@/lib/rewards/earn";
import { requireAppAttestStructural } from "@/lib/app-attest";
import { rateLimitAsync } from "@/lib/rate-limit";
import { recordSendLatency, takePendingInbound } from "@/lib/perf-cache";
import { notifyInboundSettlement } from "@/lib/notify";
import { getCurrentEpoch } from "@/lib/sui-epoch";
import {
  LOG as SAVE_LOG,
  creditRoundupSave,
  type SaveOutcome,
} from "@/lib/rewards/roundup";
import { trackConfirmedExecution } from "@/lib/analytics/emit";

export const runtime = "nodejs";

/**
 * Per-leg timeout wrapper that THROWS on timeout (unlike the
 * fallback-returning variant in lib/activity.ts / earn/withdraw/prepare).
 *
 * Why throw? sponsor-execute moves money. A silent fallback on the proof
 * mint or Onara POST would either drop the send (false failure) or, worse,
 * return a fake success without a digest (false success, exactly what we
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
 *   2. POST { sender, txBytes, txSignature } to Onara's /sponsor endpoint -
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
  // Gate reads run CONCURRENTLY, app-access, rate limit and the user row
  // are independent lookups; serial they stacked 3 DB round-trips on the
  // execute critical path. Denial precedence is unchanged.
  const [denied, rl, user] = await Promise.all([
    // Private-beta guardrail: signed-in is not enough, the account must be
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
     * before crediting, a malicious client can at worst inflate their
     * own points balance, never anyone else's money.
     */
    meta?: {
      // `consolidate` is the one-time "Enable gasless balance" tap that
      // burns the user's Coin<USDsui> objects into their accumulator.
      // The kind is accepted here so the request validates, but the
      // ALLOWED earn-trigger set below does NOT include it, we don't
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
       * Spend + Save. The HMAC-signed proof `/api/send/sponsor-prepare`
       * minted for THIS transaction when it appended the NAVI supply leg to
       * the send's PTB. It carries `(userId, digest, gross, net)` under the
       * server's own signature, so the client can forward it but cannot
       * author one, cannot change the amount, and cannot point it at another
       * transaction.
       *
       * `meta.roundupUsd` used to be accepted here and bumped
       * `users.roundup_saved_usd` straight from the request body, with a
       * comment claiming a lying client "will fail Sui validation at
       * sponsor-time". Nothing cross-checked `meta` against the signed PTB,
       * so the tally rose on sends where no save existed at all. That field
       * is gone; a client-supplied savings figure is never credited again.
       */
      saveProof?: string;
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

  // Mobile callers don't have a signing cookie, pull jwt+salt + binding
  // from the mobile_sessions row instead. Web callers stay on the cookie
  // path. Pass the client's ephemeral pubkey so mobileSigningContext picks
  // the row bound to THIS signing key (not merely the newest row, which can
  // carry a stale/expired max_epoch, the exact cause of the Onara "ZKLogin
  // expired at epoch N" deposit failures).
  const signing = isMobileRequest(req)
    ? await mobileSigningContext(userId, body.ephemeralPubKeyB64)
    : await readSigningCookie();
  if (!signing) {
    return NextResponse.json({ error: "No active sign-in" }, { status: 401 });
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
          error: "Sign in again, your session predates the latest fix.",
          code: "session_rebind_required",
        },
        { status: 401 }
      );
    }
  }

  const ephemeralPubKeyB64 = bound?.ephemeralPubKeyB64 ?? body.ephemeralPubKeyB64;
  const maxEpochToUse = bound?.maxEpoch ?? body.maxEpoch;
  const randomnessToUse = bound?.randomness ?? body.randomness;

  // Expired-binding guard (mobile only). The zkLogin nonce is bound to
  // `maxEpochToUse` at sign-in and CANNOT be swapped afterward, so if that
  // epoch is already past on chain the proof is dead, Onara would reject it
  // with the cryptic "ZKLogin expired at epoch N, current epoch M". Catch it
  // HERE and return the same clean rebind signal the iOS client already
  // handles (mapExecuteError → SessionError.rebindRequired → sign-in prompt),
  // mirroring the null-binding guard above. The epoch read is memoized 30s in
  // lib/sui-epoch, so this doesn't add a fullnode round-trip to the hot path.
  //
  // NOTE: does NOT touch the send/gasless rail, gasless-submit uses
  // body.maxEpoch on its own path and never calls this route.
  if (isMobileRequest(req)) {
    try {
      const currentEpoch = await getCurrentEpoch();
      if (maxEpochToUse <= currentEpoch) {
        console.warn(
          `[zk/sponsor-execute] expired binding for user=${userId}: maxEpoch=${maxEpochToUse} <= currentEpoch=${currentEpoch}, routing to rebind`
        );
        return NextResponse.json(
          {
            error: "Sign in again, your session has expired.",
            code: "session_rebind_required",
          },
          { status: 401 }
        );
      }
    } catch (e) {
      // If we cannot read the epoch (fullnode blip), DON'T block the send -
      // fall through and let Onara be the authority. This preserves the
      // working rail: at worst the user sees the old Onara error on the rare
      // occasion the epoch read fails AND the binding is genuinely expired.
      console.warn("[zk/sponsor-execute] epoch pre-check unavailable, proceeding:", e);
    }
  }

  // Pin to non-undefined locals, TS doesn't carry the validation-block
  // narrowing of `body.*` through the IIFE closure below.
  const bytesB64 = body.bytesB64;
  const userSignature = body.userSignature;

  // Outer route cap. iOS used to hit URLSession's 60s default before
  // anything in here could fall over cleanly. We promise-race the whole
  // pipeline against 25s so we ALWAYS surface a JSON error before iOS
  // gives up, request-timeout on the client is now 30s, this fires first.
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

  // Does this send carry an atomic Spend + Save leg? If so we need a
  // DEFINITIVE on-chain outcome rather than the optimistic ACK a plain send
  // is happy with: the savings tally may only move for a save we have read
  // back off chain, and with no cron there is no later pass to do it.
  const saveProof =
    typeof body.meta?.saveProof === "string" && body.meta.saveProof.length > 0
      ? body.meta.saveProof
      : null;

  const work = (async () => {
    const t0 = Date.now();
    // Proof mint: cached path ~250ms, fresh Shinami ~2-4s, fresh GPU
    // ~400ms. 12s ceiling is 3x the worst hot path, anything beyond
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
    // logs. Confirms ZK_PROVER_PRIMARY routing is actually winning -
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
    //, only on malformed PTB or balance race), we don't surface that
    // here. iOS resolves the actual outcome by polling the digest
    // (HomeView's optimistic-balance path already does this).
    //
    // CONTRACT: the iOS client times the whole sponsor-execute request out at
    // 30s (ZkLoginCoordinator.zkSession). The server must return a DEFINITIVE
    // result (success or a clean JSON error) BEFORE 30s, so the server's error
    // wins the race instead of iOS's generic "Send timed out, no funds moved".
    // Total server time = proof leg + this Onara leg. A cached proof is ~1s and
    // a fresh mint a few seconds. Since the session policy now re-auths on every
    // cold start (proof is always freshly warmed at sign-in), the proof leg is
    // ~1s, so a 26s Onara cap still keeps the total under iOS's 30s. The extra
    // headroom matters for SHARED-OBJECT sponsored txs (a Save-on-send appends a
    // NAVI supply leg; cheque/stream create), which take longer to sequence than
    // a plain owned-coin send and were timing out at the old 20s cap. (A 50s cap
    // broke the race: it ran past iOS's 30s and reported false failures.)
    // Env-tunable via ONARA_SPONSOR_TIMEOUT_MS, but keep it under ~28s.
    const onaraCapMs = Number(process.env.ONARA_SPONSOR_TIMEOUT_MS) || 26_000;
    const broadcast = (sig: string) =>
      withLegTimeout(
        onaraClient.sponsor({
          sender: user.sui_address,
          txBytes: bytesB64,
          txSignature: sig,
          // Optimistic for a plain send (iOS polls the digest). DEFINITIVE
          // for a Save-ON send: the tally may only move for a save we have
          // read back off chain, and with no cron there is no second pass, so
          // this request has to see the transaction land.
          waitForExecution: saveProof != null,
          // Skip Onara's pre-broadcast simulate, one fewer RPC round-trip on
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
      // Groth16 verify failure. The server holds the jwt+salt, re-mint a
      // FRESH proof and retry ONCE instead of dead-ending the send (the
      // response's freshProof then replaces the client's stale cache). If
      // the JWT itself is too old to prove, the mint throws and the proof-
      // leg error mapping below converts it to session_rebind_required.
      if (!assembled.isFresh && body.cachedProof && isStaleProofError(err)) {
        console.warn(
          `[zk/sponsor-execute] stale cached proof rejected on-chain (user=${userId}), re-minting fresh and retrying once`
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
    // Logged on EVERY successful response (defense in depth), grep
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

    // Rewards earn, fire-and-forget. The user's money already moved;
    // if the points write fails (DB hiccup, etc.) we don't block the
    // response. Validation here is server-side: only the closed kind
    // enum, only positive amounts up to a per-tx cap (defends against
    // a malicious client inflating their own points balance, at worst
    // a single tx earns the cap, never more).
    const meta = body.meta;
    if (
      meta &&
      // A Save-ON send books the round-up's own award from the settlement
      // path below, against the digest it verified. The `send` award still
      // runs here as normal; only the round-up leg is withheld from the
      // unverified `meta` path.
      true &&
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
        // can exceed this, the user just doesn't farm extra points
        // beyond it.
        const amountUsd = Math.min(meta.amountUsd, 10_000);
        // Don't await, we'll return to iOS as soon as we have the
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
    // executeTransaction, a discriminated union shaped like:
    //   { $kind: 'Transaction',       Transaction:       { digest, effects, ... } }
    //   { $kind: 'FailedTransaction', FailedTransaction: { digest, ... } }
    // So `result.digest` is undefined; the digest is one level deeper.
    // Fall through several known shapes for resilience to upstream
    // changes, we'd rather extract a digest than fail the send over
    // a field-name diff.
    const r = result as Record<string, unknown>;
    const okTx =
      (r.Transaction as { digest?: string; effects?: unknown } | undefined) ??
      (r.transaction as { digest?: string; effects?: unknown } | undefined);
    const failedTx = r.FailedTransaction as { digest?: string } | undefined;

    // MONEY-SAFETY: a tx that is ADMITTED then Move-ABORTS comes back as a
    // FailedTransaction that STILL carries a digest. Never report that as a
    // delivered send, the recipient was not paid and the balance must not drop.
    if ((r.$kind as string | undefined) === "FailedTransaction" || (failedTx && !okTx)) {
      console.error(
        `[zk/sponsor-execute] FAILED on-chain tx user=${userId} digest=${failedTx?.digest ?? ""}`,
        JSON.stringify(failedTx ?? r)
      );
      // An atomic Save-ON send that aborted moved NOTHING: not the transfer,
      // not the save. Nothing to unwind, and nothing may be credited. The
      // 502 below is the send's own failure and covers both legs.
      if (saveProof) {
        console.error(
          `${SAVE_LOG} SAVE_FAILED user=${userId} the send+save PTB aborted on chain, neither leg landed`
        );
      }
      return NextResponse.json(
        { error: "transaction failed on chain (aborted), funds not moved", code: "TX_ABORTED" },
        { status: 502 }
      );
    }

    const digest = (r.digest as string | undefined) ?? okTx?.digest ?? "";
    if (!digest) {
      // Log the raw shape so we can fix the extractor without guessing.
      console.error(
        "[zk/sponsor-execute] no digest in Onara response, shape:",
        JSON.stringify(Object.keys(r))
      );
    }

    // Notify the RECIPIENT that money landed. The stash was set in
    // sponsor-prepare; previously only gasless-submit consumed it, so
    // SPONSORED sends (Spend+Save round-ups, cross-currency, any Move-call
    // send) settled without ever notifying the recipient. Consume it here too
    // so every inbound send pushes. Fire-and-forget, never gates the
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

    // ── GROWTH ────────────────────────────────────────────────────────
    // Placed HERE, and only here, because this is the first point in the route
    // where the transaction is CONFIRMED: the FailedTransaction branch above has
    // already returned for anything that aborted on chain, so reaching this line
    // means Onara accepted and broadcast the PTB. `digest` gates the call so a
    // digest-less response (a shape we log but tolerate) never books a fee.
    //
    // This is the single busiest money route in the app and it is the reason
    // `send_completed`, `earn_supplied` and `swap_completed` had no emitter: the
    // route is generic, so it maps the SAME already-validated `meta.kind` hint
    // the rewards engine uses onto the event taxonomy.
    //
    // Cannot fail or delay the send: `trackConfirmedExecution` is synchronous,
    // returns void, wraps its own body, and every write it schedules runs in
    // `after()` — post-response. It is deliberately BELOW the awaits it measures
    // and ABOVE nothing that awaits it.
    if (digest) {
      trackConfirmedExecution({
        userId,
        digest,
        kind: meta?.kind,
        amountUsd: meta?.amountUsd,
        venue: meta?.venue,
        surface: "send.sponsored",
      });
    }

    // ── Spend + Save settlement ──────────────────────────────────────
    // The ONLY place `users.roundup_saved_usd` can move, and it moves off
    // TWO server-side facts, never off the request body:
    //
    //   1. `meta.saveProof`, HMAC-signed by sponsor-prepare over
    //      (userId, digest, gross, net) for THIS transaction. The client
    //      carries it; it cannot mint or edit one.
    //   2. A read of that digest back off chain: succeeded, sent by this
    //      user, USD stablecoin out, the save fee reached the treasury, and
    //      money landed in a non-address sink (the NAVI reserve).
    //
    // The credited figure is the MINIMUM of the two, so it can never exceed
    // the money that actually moved. Idempotent via a UNIQUE claim key, so
    // a retried request cannot credit twice. See lib/rewards/roundup.ts.
    let saveOutcome: SaveOutcome | null = null;
    if (saveProof) {
      if (!digest) {
        console.error(
          `${SAVE_LOG} no digest for a save-carrying send user=${userId}; nothing credited`
        );
      } else {
        try {
          saveOutcome = await creditRoundupSave({
            userId,
            senderAddress: user.sui_address,
            digest,
            proofToken: saveProof,
            // The broadcast above waited for execution, but the READ path can
            // still lag a beat behind it. Three looks inside this request.
            verifyRetries: 3,
          });
        } catch (e) {
          console.warn(
            `${SAVE_LOG} credit threw user=${userId} ${digest}: ${(e as Error).message}`
          );
        }
        if (saveOutcome?.status === "pending") {
          // The money moved (the transfer and the save are the same
          // transaction, and the transfer succeeded) but this server could
          // not read it back in time to prove the amount. We do NOT credit on
          // a guess. The client is told `pending` and may confirm once via
          // /api/send/save-confirm, which is a retried READ, not a queue.
          console.warn(
            `${SAVE_LOG} save ${digest} not verifiable yet (${saveOutcome.reason}); not credited, client may re-confirm`
          );
        }
      }
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
      // Present only when the send carried a save leg. The receipt must
      // render THIS, never the amount it hoped to save:
      //   saved    the tally moved by `savedUsd`.
      //   pending  the send landed and the save is inside it, but we could
      //            not read it back yet, so nothing is credited. The client
      //            may re-confirm once via /api/send/save-confirm.
      //   failed   nothing was credited and nothing will be.
      ...(saveProof
        ? {
            save: {
              status: saveOutcome?.status ?? "pending",
              savedUsd: saveOutcome?.status === "saved" ? saveOutcome.savedUsd : 0,
              reason:
                saveOutcome && saveOutcome.status !== "saved"
                  ? saveOutcome.reason
                  : undefined,
            },
          }
        : {}),
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
    // happen in practice (each leg has its own shorter cap), surfacing
    // it distinctly so we'd notice in logs.
    if (e.code === "ROUTE_TIMEOUT") {
      console.error("[zk/sponsor-execute] route deadline exceeded");
      return NextResponse.json(
        { error: "Send timed out. Please try again.", code: "ROUTE_TIMEOUT" },
        { status: 504 }
      );
    }

    // Proof mint took too long, almost always Shinami congestion or a
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
    // mismatch), that's a SESSION problem, not a prover outage: route the
    // client to a clean re-sign-in instead of an opaque 502 it would retry
    // forever (the iOS money flows all handle session_rebind_required).
    if (e.leg === "proof") {
      if (/-32602|invalid params/i.test(msg)) {
        return NextResponse.json(
          {
            error: "Sign in again, your session needs a refresh.",
            code: "session_rebind_required",
          },
          { status: 401 }
        );
      }
      // Network glitch, Shinami 5xx, GPU down. The zksigner already
      // exhausted its primary→fallback chain, we're out of options for
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
