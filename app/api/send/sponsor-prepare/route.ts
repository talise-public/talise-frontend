import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import { checkSendAllowed, recordSend } from "@/lib/send-limits";
import {
  Transaction,
  TransactionDataBuilder,
  coinWithBalance,
} from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { sui, network, COIN_TYPES, USDSUI_DECIMALS, getUsdsuiBalanceStrict } from "@/lib/sui";
import { USDSUI_TYPE } from "@/lib/usdsui";
import { appendPaymentKitReceipt } from "@/lib/intents/wrap-payment-kit";
import {
  LOG as SAVE_LOG,
  getRoundupConfig,
  issueSaveProof,
  planRoundup,
  roundupConfigMemoKey,
  type RoundupPlan,
} from "@/lib/rewards/roundup";
import { appendNaviSupply, SAVE_TREASURY_FEE_BPS } from "@/lib/navi-supply";
import { onara } from "@/lib/onara";
import { screenTransfer } from "@/lib/screening";
import { getCurrentEpoch, getChainIdentifier } from "@/lib/sui-epoch";
import {
  memoTtl,
  recordSendLatency,
  setPendingInbound,
} from "@/lib/perf-cache";
// NOTE: ensurePaymentRegistry() is intentionally NOT imported here.
// The registry has existed on chain for weeks; the only legitimate caller
// is `/api/zk/warmup`, which runs once at dashboard load. Keeping it on
// the prepare hot path paid a cold-start cost on the FIRST send per Node
// process for no benefit.

export const runtime = "nodejs";

/**
 * POST /api/send/sponsor-prepare
 *
 * Combined replacement for `/api/send/prepare` + `/api/zk/sponsor`.
 *
 * Before: iOS made two serial round-trips, prepare returned the
 * PTB kind bytes, sponsor wrapped them with the gas owner. Each cost
 * one full iOS→Vercel network hop (~500ms cold). This endpoint does
 * both server-side in one call:
 *
 *   1. Build the PTB (Payment Kit wrap, plus the Spend + Save NAVI supply
 *      leg in the SAME PTB when round-up is on, see below).
 *   2. Resolve the Onara sponsor address + reference gas price in
 *      parallel (both 60s-memoized → typically <1ms on warm).
 *   3. Set sender + gasOwner + gasPrice on the tx.
 *   4. Run the FULL `tx.build()` (with client) to produce the
 *      sponsor-ready bytes.
 *
 * Returns `{ bytes, mode, save, receiptNonce }`, the client signs `bytes`
 * directly and forwards to `/api/zk/sponsor-execute` (or
 * `/api/send/gasless-submit` on the gasless rail). One fewer round-trip →
 * ~500–800ms saved per send.
 *
 * ── Spend + Save: ONE atomic PTB ────────────────────────────────────
 *
 * With round-up on, this route routes the send onto the SPONSORED rail and
 * appends `appendNaviSupply` to the send's own PTB. One signature, one
 * digest, both legs atomic: if the save aborts, the send aborts with it,
 * and there is no way to end up with a savings tally and no money behind
 * it. The gasless rail cannot carry the supply leg at all (gasPrice=0,
 * gasBudget=0, empty gas payment, and a validator allowlist of
 * `0x2::balance::send_funds<T>` only), which is why round-up forces the
 * sponsored rail rather than trying and falling back.
 *
 * The save leg is bounded by `NAVI_APPEND_DEADLINE_MS`. On timeout or any
 * build error the route falls back to a send-only PTB and reports
 * `save.applied: false` with a reason. THE PAYMENT NEVER FAILS BECAUSE OF
 * THE ROUND-UP: that was the flaw in the pre-2026-06-22 bundled version,
 * and it is why measuring the NAVI leg mattered before rebuilding it (see
 * the header of lib/rewards/roundup.ts for the numbers).
 *
 * The legacy `/api/send/prepare` + `/api/zk/sponsor` endpoints stay
 * around for the Earn flows and any older builds that haven't been
 * cut over to the combined path.
 */

const SUPPORTED_ASSETS = new Set(["USDsui", "SUI"]);
const ADDRESS_RE = /^0x[a-f0-9]{64}$/i;

// Fixed gas budget for the sponsored rail (0.06 SUI). Generous cap so the SDK
// selects gas coins totaling >= this (pulling in the sponsor's main coin past
// any dust); the sponsor pays only the actual gas used. See the build step.
const SPONSOR_GAS_BUDGET_MIST = 60_000_000n;

/**
 * Hard ceiling on how long the Spend + Save NAVI leg may take to append.
 *
 * MEASURED on mainnet (scripts/probes/probe-spend-save-latency.mjs):
 * `appendNaviSupply` runs in 268 ms once `/api/zk/warmup` has warmed the
 * adapter (p50 262 / p95 558), and 3344 ms on the very first call in a cold
 * lambda that never got warmed. 6s therefore clears even the unwarmed cold
 * case with room to spare, while still bounding a genuinely wedged NAVI/RPC
 * upstream so it can never eat the prepare route's budget and turn a payment
 * into a 500. On timeout we drop the save and send anyway.
 */
const NAVI_APPEND_DEADLINE_MS = Number(process.env.ROUNDUP_APPEND_DEADLINE_MS) || 6_000;

/** What the response tells the client about the Spend + Save leg. */
type SavePayload = {
  /** True only when the NAVI supply leg is actually IN the bytes returned. */
  applied: boolean;
  /** Gross round-up leaving the wallet, USDsui. 0 when not applied. */
  grossUsd: number;
  /** What reaches NAVI (gross minus the save fee). 0 when not applied. */
  netUsd: number;
  feeBps: number;
  venue: "navi";
  /**
   * HMAC-signed, digest-bound proof of the round-up this PTB carries. The
   * client hands it to `/api/zk/sponsor-execute` as `meta.saveProof`; it is
   * the ONLY way the savings tally can move, and it cannot be authored or
   * altered client-side. Present iff `applied`.
   */
  proof?: string;
  /** Why the save is not applied, when the user has round-up on. */
  reason?: string;
};

/** Race `p` against the deadline. Rejects with a tagged error on timeout. */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export async function POST(req: Request) {
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
  // Gate reads run CONCURRENTLY, app-access, rate limit and the user row are
  // independent lookups, and running them serially put 3 stacked DB
  // round-trips on every send's critical path. Denial precedence is
  // unchanged: allowlist first, then rate limit, then user-row.
  const [denied, rl, user] = await Promise.all([
    // Private-beta guardrail: signed-in is not enough, the account must be
    // on the app allowlist before it can originate any value-moving call.
    denyUnlessAppApproved(userId),
    // Per-user global rate limit on this money route (anti-abuse / anti-DDoS).
    rateLimitAsync({ key: `sponsor-prepare:user:${userId}`, limit: 30, windowSec: 3600 }),
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
    to?: string;
    amount?: number | string;
    asset?: string;
    /**
     * Allow falling back to the Onara-sponsored rail when the gasless rail
     * can't serve this send, instead of returning a 400.
     *
     * The gasless rail (`balance::send_funds`) can ONLY source from the
     * user's Address-Balance accumulator; it is provably impossible for
     * users whose USDsui sits in `Coin<USDSUI>` objects. Talise-facilitated
     * money-out flows (off-ramp cash-out, pay-to-bank) promise the user a
     * fee-free transfer ("No network fee, sponsored by Talise") and MUST
     * land regardless of the user's coin/accumulator balance shape.
     *
     * With this set we still TRY gasless first, so a user whose funds are
     * already in the accumulator gets a genuinely free transfer and Talise
     * pays nothing, and only when gasless can't build do we fall through to
     * Payment Kit (which sources from Coin objects via
     * `coinWithBalance({useGasCoin:false})`) on Onara-sponsored gas. Plain
     * P2P sends leave it unset and a gasless failure stays a hard 400, per
     * the 2026-05-29 directive (a "free" send must never silently sponsor).
     *
     * `sponsored` is accepted as a legacy alias for the same intent.
     */
    sponsorFallback?: boolean;
    sponsored?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const to = (body.to ?? "").trim().toLowerCase();
  if (!ADDRESS_RE.test(to)) {
    return NextResponse.json(
      { error: "recipient must be a 0x-prefixed Sui address" },
      { status: 400 }
    );
  }
  if (to === user.sui_address.toLowerCase()) {
    return NextResponse.json(
      { error: "you can't send to your own wallet" },
      { status: 400 }
    );
  }

  // Talise-sponsored money-out flows (off-ramp, pay-to-bank) opt into a
  // sponsored fallback, see the `sponsorFallback` body field above. We still
  // try gasless first (free when the user's funds are in the accumulator) and
  // only sponsor when the gasless build can't serve the send.
  const sponsorFallback = body.sponsorFallback === true || body.sponsored === true;

  const asset = body.asset ?? "USDsui";
  if (!SUPPORTED_ASSETS.has(asset)) {
    return NextResponse.json(
      { error: `asset must be one of ${[...SUPPORTED_ASSETS].join(", ")}` },
      { status: 400 }
    );
  }

  const amountNum = Number(body.amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return NextResponse.json(
      { error: "amount must be a positive number" },
      { status: 400 }
    );
  }

  const decimals = asset === "USDsui" ? USDSUI_DECIMALS : 9;
  const onchain = BigInt(Math.round(amountNum * 10 ** decimals));
  if (onchain <= 0n) {
    return NextResponse.json({ error: "amount too small" }, { status: 400 });
  }
  // Sui validator-side rule (docs-confirmed):
  // https://docs.sui.io/develop/transaction-payment/gasless-stablecoin-transfers
  //   "All gasless stablecoin transfers have a minimum transfer balance
  //    of 0.01. Transfers below this minimum will not be executed."
  // 0.01 USDsui = 10,000 µ. Reject upfront with a clear copy instead of
  // letting the validator reject the tx ~1s later under an opaque
  // "Invalid withdraw reservation" string.
  // A send below the gasless minimum can't take the gasless rail. For a plain
  // P2P send that's a hard 400. For a sponsor-fallback flow it's fine, we
  // simply skip the gasless attempt (see `tryGasless` below) and let Payment
  // Kit handle it on sponsored gas, where the minimum doesn't apply.
  const MIN_GASLESS_MICROS = 10_000n;
  const belowGaslessMin = asset === "USDsui" && onchain < MIN_GASLESS_MICROS;
  if (belowGaslessMin && !sponsorFallback) {
    return NextResponse.json(
      {
        error:
          "Gasless USDsui sends have a 0.01 minimum. Increase the amount to at least 0.01 USDsui and try again.",
        code: "BELOW_GASLESS_MINIMUM",
        minMicros: MIN_GASLESS_MICROS.toString(),
      },
      { status: 400 }
    );
  }

  // ── Compliance screening, HARD STOP (master plan §7) ───────────
  // Pre-broadcast sanctions + on-chain address risk. Runs AFTER we've
  // resolved the user row and validated the recipient, but BEFORE any
  // PTB bytes are built/returned, so a flagged transfer never produces
  // signable bytes. `screenTransfer` is fail-closed on an explicit
  // sanctioned-name hit and fail-open (logs, allows) on an address-risk
  // provider/transport error, a vendor outage must not 500 every send.
  // `business_name` is preferred for the sender (business accounts settle
  // under their legal/registered name); falls back to the personal name.
  const screen = await screenTransfer({
    senderAddr: user.sui_address,
    recipientAddr: to,
    senderName: user.business_name ?? user.name,
    // Recipient is an on-chain address only at this layer; no name to
    // screen yet. The address-risk leg covers the recipient.
    recipientName: null,
  });
  if (!screen.allow) {
    console.warn(
      `[send/sponsor-prepare] SCREENING_BLOCK user=${userId} to=${to} cause=${screen.cause} reason=${screen.reason}`
    );
    return NextResponse.json(
      {
        error: "This transfer was blocked by a compliance screen.",
        code: "SCREENING_BLOCK",
        reason: screen.reason,
      },
      { status: 403 }
    );
  }

  // ── Hard transaction-limit gate (master plan §7, §11 item 2) ────
  // AFTER screening (block bad actors first), BEFORE any PTB-building
  // work: reject sends that would breach the user's tier-based rolling
  // daily/monthly cap. USDsui is 1:1 USD so `amountNum` IS the USD
  // figure; SUI sends aren't USD-denominated so only USDsui is gated.
  // `checkSendAllowed` is fail-open by contract (a limits-infra fault
  // resolves to allowed, never a 500). Reservation recorded on success.
  if (asset === "USDsui") {
    const decision = await checkSendAllowed(userId, amountNum);
    if (!decision.allowed) {
      console.warn(
        `[send/sponsor-prepare] LIMIT_EXCEEDED user=${userId} tier=${decision.tier} ` +
          `window=${decision.window} amount=${amountNum} used=${decision.used} limit=${decision.limit}`
      );
      return NextResponse.json(
        {
          error: `This send would exceed your ${decision.window} limit of $${decision.limit.toLocaleString()}. You've sent $${decision.used.toLocaleString()} in this window.`,
          code: "LIMIT_EXCEEDED",
          window: decision.window,
          limit: decision.limit,
          used: decision.used,
        },
        { status: 403 }
      );
    }
  }

  // ── Spend + Save: one atomic PTB, on the sponsored rail ─────────────
  // Round-up config is memo'd per-user for 60s (toggling is rare relative to
  // send frequency). Defensive fallback on read failure: treat as disabled so
  // a config error never blocks a send. `getRoundupConfig` also applies the
  // ROUNDUP_ENABLED product gate, so a closed gate lands here as "off".
  const roundupCfg = await memoTtl(
    // Shared with setRoundupConfig's invalidation so a toggle takes effect on
    // the next send instead of up to 60s later.
    roundupConfigMemoKey(userId),
    60_000,
    () =>
      getRoundupConfig(userId).catch(() => ({
        enabled: false,
        percentage: 0,
        savedUsd: 0,
      }))
  );
  // Server-computed round-up for this send. The client never states this
  // number anywhere in the flow, and never sees a knob that changes it.
  const plan: RoundupPlan | null =
    asset === "USDsui"
      ? planRoundup({ config: roundupCfg, sendAmountUsd: amountNum })
      : null;

  // What we report when there is no save leg in the bytes. `applied: false`
  // with a reason is how the client knows to say "not saved" instead of
  // painting a green "Rounded up $X" over a send that saved nothing.
  const noSave = (reason?: string): SavePayload => ({
    applied: false,
    grossUsd: 0,
    netUsd: 0,
    feeBps: SAVE_TREASURY_FEE_BPS,
    venue: "navi",
    ...(reason ? { reason } : {}),
  });

  // ── Balance cover check, protects the SEND ──────────────────────────
  // The atomic PTB spends `amount + gross`. If the wallet cannot cover both,
  // the supply leg aborts on chain and takes the payment down with it. So we
  // check first and drop the SAVE (never the send) when the money isn't
  // there. Kicked off now so it overlaps the screening + limit reads below.
  //
  // `getUsdsuiBalanceStrict` THROWS on a failed read rather than returning a
  // misleading 0; on a throw we also drop the save, because "we don't know
  // the balance" is not a basis for adding a leg that can abort a payment.
  const coverPromise: Promise<{ ok: boolean; reason?: string }> | null = plan
    ? getUsdsuiBalanceStrict(user.sui_address).then(
        (b) =>
          b.usdsui >= amountNum + plan.grossUsd
            ? { ok: true }
            : {
                ok: false,
                reason: `balance ${b.usdsui} cannot cover send ${amountNum} + round-up ${plan.grossUsd}`,
              },
        (e) => ({ ok: false, reason: `balance read failed: ${(e as Error).message}` })
      )
    : null;

  // Flips to true if the gasless try-block hits a categorized "expected"
  // failure (Coin-only balance state or accumulator underfunded) and we
  // fall through to the sponsored branch below. Used to surface
  // `mode: "sponsored-coin-fallback"` so analytics + iOS can tell this
  // apart from regular sponsored sends.
  // See: docs/sui-rpc-migration/gasless-notes.md
  //   §"Proof: coin::send_funds is not gasless for Coin-object holders"
  let gaslessFellBack = false;
  // Tracks whether the fall-through was triggered by the "no
  // address-owned input" dead-end specifically (vs the older
  // Coin-state mismatch). When true, response surfaces
  // mode: "sponsored-anchor-fallback" instead of
  // "sponsored-coin-fallback" so logs + iOS analytics can tell them
  // apart.
  let gaslessFellBackReason: "coin" | "anchor" = "coin";

  // ── RAIL CHOICE ─────────────────────────────────────────────────────
  // A Save-ON send goes straight to the SPONSORED rail and does not attempt
  // gasless at all. This is not a preference, it is the shape of the chain:
  // the gasless rail builds with gasPrice=0, gasBudget=0, an empty gas
  // payment and an offline BCS build, and the validator's gasless allowlist
  // admits only `0x2::balance::send_funds<T>`, so a NAVI supply (shared
  // objects, a Pyth oracle refresh, a treasury fee transfer) provably cannot
  // ride along. Attempting gasless first would burn a build + simulate
  // round-trip to learn that.
  //
  // Save OFF is untouched: every USDsui send still tries gasless first and
  // stays free. Sub-minimum sponsor-fallback sends skip straight to Payment
  // Kit (the only path below 0.01) rather than attempting a build that can't
  // pass.
  const saveActive = plan != null;
  const tryGasless = asset === "USDsui" && !belowGaslessMin && !saveActive;
  if (tryGasless) {
    try {
      const t0 = Date.now();
      const client = sui();
      const tx = new Transaction();
      tx.setSender(user.sui_address);

      // ───────────────────────────────────────────────────────────────
      // DIRECTIVE (2026-05-30, revised 2026-06-01): accumulator-only PTB
      // + ValidDuring expiration, built OFFLINE on the gRPC client.
      //
      // The validator requires every PTB to EITHER carry an
      // address-owned input OR set a `ValidDuring` expiration with at
      // most two epochs of validity. A pure accumulator pull
      // (`tx.balance({balance})`) has no address-owned input, so the
      // escape hatch is mandatory. This mirrors the SDK's own parallel
      // executor in `addressBalance` gas mode
      // (`@mysten/sui/transactions/executor/parallel.mjs`
      // #getValidDuringExpiration), INCLUDING its `setGasPayment([])`,
      // which is the load-bearing line (see the build step below).
      tx.moveCall({
        target: "0x2::balance::send_funds",
        typeArguments: [USDSUI_TYPE],
        arguments: [
          tx.balance({ type: USDSUI_TYPE, balance: onchain }),
          tx.pure.address(to),
        ],
      });
      // Both gasPrice AND gasBudget must be explicitly 0; the validator's
      // gasless gate rejects auto-picked budgets even when the price is 0.
      tx.setGasPrice(0n);
      tx.setGasBudget(0n);

      // ValidDuring escape hatch: tells the validator this PTB is valid
      // for the current + next epoch, the maximum window the gasless rail
      // allows. `chain` MUST be the base58 chainIdentifier (immutable per
      // network), NOT a network label. Both reads are memoized and walk
      // the gRPC multi-endpoint fallback (lib/sui-epoch.ts).
      const [chainId, currentEpoch] = await Promise.all([
        getChainIdentifier(),
        getCurrentEpoch(),
      ]);
      const epochBig = BigInt(currentEpoch);
      tx.setExpiration({
        ValidDuring: {
          minEpoch: String(epochBig),
          maxEpoch: String(epochBig + 1n),
          minTimestamp: null,
          maxTimestamp: null,
          chain: chainId,
          nonce: (Math.random() * 4294967296) >>> 0,
        },
      });

      // THE load-bearing line. An empty-array gas payment flips the SDK's
      // `needsTransactionResolution()` to false, so `tx.build()` SKIPS its
      // build-time validator simulate and BCS-serializes the PTB offline.
      // Without it the gRPC build fires a resolve-time simulate that still
      // rejects the `ValidDuring` variant in @mysten/sui 2.16.3 ("unknown
      // TransactionExpirationKind"); WITH it the gRPC build produces bytes
      // BYTE-IDENTICAL to the old JSON-RPC build (verified live, fixed
      // nonce, see web/scripts/probe-grpc-gasless.mjs). This is what lets
      // the whole gasless build run on gRPC; the JSON-RPC dependency is
      // gone (JSON-RPC fullnodes sunset ~July 2026 regardless).
      tx.setGasPayment([]);

      // Build OFFLINE on the gRPC client, the only client touch during
      // build is the CoinWithBalance intent's balance read.
      const bytes = await tx.build({ client: client as never });

      // The offline build skips the validator simulate, so run an EXPLICIT
      // gRPC simulate to preserve the prepare-time categorization the
      // JSON-RPC build used to give us (underfunded accumulator, the
      // "use the whole balance or leave ≥10000" dust rule, etc.). A
      // FailedTransaction throws with the validator's status text so the
      // catch below maps it to the right user-facing code, and, critically,
      // we NEVER hand iOS signable bytes for a tx the validator would reject
      // at execute. `simulateTransaction` is routed through the sui() proxy's
      // BROADCAST chain (suiGrpcBroadcast), which bypasses the Hayabusa read
      // proxy, Hayabusa 502s simulate, so this must hit a direct fullnode.
      const sim = (await client.simulateTransaction({
        transaction: bytes,
        include: { effects: true },
      } as never)) as {
        $kind?: string;
        FailedTransaction?: {
          effects?: {
            status?:
              | { error?: { description?: string; message?: string } }
              | string;
          };
        };
      };
      if (sim.$kind !== "Transaction") {
        // Surface the validator's HUMAN-READABLE reason so the catch below
        // can categorize it (ACCUMULATOR_UNDERFUNDED, the "leave ≥10000"
        // dust rule, etc.). The gRPC FailedTransaction nests it at
        // effects.status.error.description; fall back to the stringified
        // status / discriminant if the shape ever differs.
        const status = sim?.FailedTransaction?.effects?.status;
        const reason =
          (typeof status === "object" && status?.error
            ? status.error.description ?? status.error.message
            : undefined) ??
          (typeof status === "string"
            ? status
            : JSON.stringify(status ?? sim.$kind));
        throw new Error(`gasless simulate rejected: ${reason}`);
      }
      const tBuild = Date.now();

      // Stash inbound-settlement notification info for gasless-submit to fire
      // once the tx confirms (we know the recipient + amount here; the submit
      // leg only has opaque bytes). Best-effort, same-instance, see perf-cache.
      setPendingInbound(userId, {
        to,
        // Prefer the sender's @talise handle so the recipient's notification
        // reads "from sele@talise" (not "someone on Talise" / a display name).
        amountUsd: amountNum,
        senderName: user.talise_username
          ? `${user.talise_username}@talise`
          : (user.business_name ?? user.name ?? "Someone on Talise"),
      });

      console.log(
        `[send/sponsor-prepare gasless] total=${tBuild - t0}ms amount=${amountNum} USDsui (no save leg on this rail)`
      );
      recordSendLatency({
        leg: "prepare",
        totalMs: tBuild - t0,
        atMs: Date.now(),
        extras: { mode: "gasless", hasRoundup: false },
      });

      // Reserve this send against the rolling limit window. Fire-and-
      // forget + best-effort (recordSend never throws) so a ledger
      // write never gates the response. Recorded at prepare-time
      // (reservation model) since the gasless rail broadcasts from iOS
      // and has no server-side post-confirm hook here.
      void recordSend({ userId, amountUsd: amountNum, asset, digest: null });

      return NextResponse.json({
        bytes: toBase64(bytes),
        mode: "gasless",
        asset,
        amount: amountNum,
        to,
        // This rail is reached only when there is no save leg (see RAIL CHOICE):
        // either the user has round-up off, or their round-up landed under
        // ROUNDUP_MIN_SAVE_USD. Report WHICH, so the client can say "round-up
        // needs a slightly larger send" instead of showing a bare success that
        // reads as the feature being broken. A silent skip here is what made a
        // ₦200 send look like a bug rather than a threshold.
        save: noSave(
          roundupCfg.enabled ? "below_minimum" : undefined
        ),
        // DEPRECATED, always 0. Pre-atomic clients treat a non-zero
        // `roundupUsd` as "now go fire the standalone save transaction"; the
        // save is inside the send PTB now, so telling them a number would
        // make them save twice. New clients read `save`.
        roundupUsd: 0,
      });
    } catch (err) {
      // LOUD by default. The previous swallow-and-fall-through pattern
      // hid real bugs, `tx.build()` failing on the gasless rail almost
      // always means EITHER (a) the user genuinely has insufficient
      // USDsui (in which case the sponsored path will fail too, Payment
      // Kit also calls `coinWithBalance({useGasCoin:false})` on the same
      // type), OR (b) something is actually broken in the gasless build
      // and we want to know loudly.
      //
      // Log the FULL stack so Vercel logs surface the real cause, and
      // distinguish two cases:
      //   • Insufficient balance, return 500 with a clear, user-facing
      //     message. iOS surfaces it; no silent fallback to a sponsored
      //     path that will also fail on chain.
      //   • Anything else, log loudly, then fall through to the
      //     sponsored path (which still uses Payment Kit and may or may
      //     not succeed, but at least the safety net runs).
      const msg = (err as Error).message ?? String(err);
      const stack = (err as Error).stack ?? "(no stack)";
      console.error(
        `[send/sponsor-prepare] GASLESS BUILD FAILED user=${userId} amount=${amountNum} USDsui:\n${stack}`
      );
      if (/insufficient balance/i.test(msg)) {
        return NextResponse.json(
          {
            error:
              "Insufficient USDsui balance. Top up your wallet and try again.",
            detail: msg,
          },
          { status: 400 }
        );
      }
      // The canonical `tx.withdrawal()` primitive pulls from the user's
      // on-chain Address Balance accumulator ONLY, it has zero visibility
      // into legacy `Coin<USDSUI>` objects sitting in the user's wallet.
      //
      // 2026-05-29 probe (web/scripts/probe-gasless-build.mjs, full
      // 25-shape matrix) PROVED gasless arbitrary-amount sends are
      // IMPOSSIBLE on chain TODAY for users whose USDsui lives in
      // Coin<USDSUI> objects rather than the accumulator. Validator
      // strings captured:
      //
      //   1. "Invalid gasless withdrawal from <accum>. Gasless
      //      transactions must either use the entire balance, or leave
      //      at least 10000 for token type USDSUI."  (accumulator path,
      //      sub-10k accumulator)
      //   2. "Transaction resolution failed: InsufficientGas"
      //      (every shape that prepends SplitCoins / mergeCoins /
      //      coin::into_balance + balance::split + balance::send_funds -
      //      validator refuses to cover intermediate-object storage with
      //      the input coin's rebate)
      //   3. "Feature is not supported: Function 0x2::pay::* | 0x2::coin::transfer | ..."
      //      (gasless allowlist explicitly excludes everything except
      //      balance::send_funds and coin::send_funds)
      //
      // The ONE shape that simulates `success:true` with `paymentCount:0`
      // is `0x2::coin::send_funds(<WHOLE_COIN>, recipient)`, but that
      // sends the entire Coin object's balance, NOT arbitrary amounts.
      //
      // See: docs/sui-rpc-migration/gasless-notes.md
      //   §"Proof: coin::send_funds is not gasless for Coin-object holders"
      //
      // Until either (a) the user's accumulator holds ≥ (amount + 10000),
      // OR (b) a public Sui framework primitive adds Coin<T>→accumulator
      // deposit to the gasless allowlist, arbitrary-amount sends from
      // Coin-only balance state MUST take the sponsored rail. The
      // sponsored fallback path runs Payment Kit (which CAN source from
      // Coin objects via `coinWithBalance({useGasCoin:false})`) and
      // surfaces as `mode: "sponsored-coin-fallback"` so iOS can
      // distinguish it from the regular sponsored path.
      //
      // TODO(gasless-coin-deposit): when Sui adds a public
      // accumulator::deposit / coin::join_to_accumulator entry function,
      // re-run probe-gasless-build.mjs to detect allowlist inclusion and
      // prepend the deposit leg to the canonical balance::send_funds PTB.
      // Product directive (2026-05-29 evening): a FREE transaction -
      // plain USDsui send with NO Spend-and-Save leg, must NEVER fall
      // through to Onara sponsorship. If the validator-side gasless
      // allowlist can't accommodate the user's balance state, the
      // honest answer is a clean 400 telling them why. The user can
      // then top up via Stripe (deposits land in the accumulator) and
      // their next send IS gasless. Sneaking Onara underneath would
      // (a) make Talise pay gas for a transaction the user told us
      // should be free, and (b) hide the underlying state mismatch.
      //
      // Note this block is only ever reached with round-up OFF: a Save-ON
      // send never attempts the gasless rail (see RAIL CHOICE), so there is
      // no Spend + Save case to special-case here any more. `sponsorFallback`
      // (off-ramp, pay-to-bank) is the only remaining reason to sponsor a
      // send whose gasless build failed.
      // Detect the "no address-owned input available" failure mode:
      // a fully-consolidated user (all USDsui in the accumulator, no
      // Coin<T> anchor) used to dead-end with:
      //   "Invalid transaction expiration: Transactions must either
      //    have address-owned inputs, or a ValidDuring expiration with
      //    at most two epochs of validity"
      // because the ValidDuring escape hatch couldn't be built. As of
      // 2026-06-01 we DO build ValidDuring offline (via setGasPayment([])
      //, see the build step above), so this case now succeeds GASLESSLY
      // and this branch is a defensive net that should rarely, if ever,
      // fire. Kept because the post-build simulate could still surface
      // this string on some unforeseen state, and the send must land.
      if (
        /Invalid transaction expiration/i.test(msg) ||
        /address-owned inputs/i.test(msg) ||
        /ValidDuring expiration/i.test(msg)
      ) {
        // PRODUCT DECISION (per user's forensic analysis): if a fully
        // consolidated user (no Coin anchor) ever does dead-end here, the
        // send MUST still land. Fall through to Onara-sponsored Payment
        // Kit instead of refusing.
        //
        // Surfaced to iOS as `mode: "sponsored-anchor-fallback"` so
        // analytics + logs can distinguish this specific dead-end
        // from regular sponsored sends or the older
        // `sponsored-coin-fallback`. The user "didn't get gasless"
        //, that's documented honestly in the mode, but their
        // tx LANDS, which is the higher-priority constraint when the
        // alternative is "your send fails until a third party sends
        // you USDsui via legacy primitives".
        //
        // When Sui ships the validator-side ValidDuring fix (or a
        // public Balance→Coin escape hatch), this branch's fall-
        // through becomes unnecessary and we can return to the 400.
        console.warn(
          `[send/sponsor-prepare] gasless requires address-owned input but user=${userId} has none (all USDsui in accumulator); falling through to sponsored-anchor-fallback. detail=${msg.slice(0, 200)}`
        );
        gaslessFellBack = true;
        gaslessFellBackReason = "anchor";
        // Intentional fall-through to the sponsored Payment Kit
        // branch below.
      } else
      if (
        (/withdraw reservation/i.test(msg) || /accumulator/i.test(msg) || /InsufficientGas/i.test(msg) || /insufficient.*balance/i.test(msg)) &&
        sponsorFallback
      ) {
        console.warn(
          `[send/sponsor-prepare] gasless unreachable for user=${userId} (Coin-only balance state); sponsorFallback opted-in, falling through to sponsored-coin-fallback. detail=${msg.slice(0, 200)}`
        );
        gaslessFellBack = true;
        // Intentional fall-through, Payment Kit handles Coin<T>
        // sourcing via coinWithBalance({useGasCoin:false}). Response surfaces
        // mode: "sponsored-coin-fallback". This is the off-ramp path: a user
        // whose USDsui is in Coin objects gets a sponsored cash-out instead
        // of a dead end, while accumulator-funded users stayed gasless above.
      } else if (/withdraw reservation/i.test(msg) || /accumulator/i.test(msg) || /InsufficientGas/i.test(msg) || /insufficient.*balance/i.test(msg)) {
        console.warn(
          `[send/sponsor-prepare] gasless unreachable for user=${userId} (accumulator underfunded); no sponsor fallback opted in, returning ACCUMULATOR_UNDERFUNDED 400. detail=${msg.slice(0, 200)}`
        );
        // The clean 2-call gasless pattern requires the requested amount
        // to live in the user's Address Balance accumulator. Coin<T>
        // objects can NOT fund this PTB (no auto-fallback, by design).
        // The user-facing remediation is now: top up via Stripe (lands
        // directly in the accumulator) OR use the manual swap CTA on
        // Home to convert other coins to USDsui. We no longer surface
        // a `canConsolidate` hint, the consolidation offer flow was
        // removed alongside the autoswap archive (2026-05-29).
        return NextResponse.json(
          {
            error:
              "Your USDsui isn't in your Address Balance accumulator yet, gasless sends require accumulator funds. Top up via Deposit (Stripe onramp lands USDsui directly in your accumulator) and try again.",
            detail: msg,
            code: "ACCUMULATOR_UNDERFUNDED",
          },
          { status: 400 }
        );
      } else if (sponsorFallback) {
        // Uncategorized gasless failure on a sponsor-fallback flow (off-ramp,
        // pay-to-bank): the transfer has to land, so fall through to the
        // sponsored Payment Kit branch rather than 400-ing.
        // This doesn't mask a real build bug, the sponsored branch runs its
        // own build + simulate and will surface any genuine failure from
        // there (outer catch → 500). A purely gasless-specific hiccup, by
        // contrast, simply succeeds on the sponsored rail.
        console.warn(
          `[send/sponsor-prepare] gasless build failed (uncategorized) for user=${userId} but sponsorFallback opted-in; falling through to sponsored-coin-fallback. detail=${msg.slice(0, 200)}`
        );
        gaslessFellBack = true;
      } else {
        // Anything else: surface as 400 so iOS does NOT silently land on
        // `mode=sponsored`. Real build bugs deserve a loud failure.
        console.error(
          `[send/sponsor-prepare] gasless build failed with an uncategorized error; surfacing as 400: ${msg}`
        );
        return NextResponse.json(
          {
            error: "Gasless USDsui send is currently unavailable. Please try again in a moment.",
            detail: msg,
            code: "GASLESS_BUILD_FAILED",
          },
          { status: 400 }
        );
      }
    }
  }

  try {
    const t0 = Date.now();
    const onaraClient = onara();
    const client = sui();
    const net = network();

    // Kick off the two expensive remote lookups IN PARALLEL while we build
    // the PTB in memory. By the time we need the sponsor / gas price
    // values, both promises are already settled (or close).
    //
    // ensurePaymentRegistry() lived here before, it was a fire-and-forget
    // call that the Promise.all still awaited. After the first call per
    // process it's a memoTtl hit, but the FIRST call paid an object lookup
    // on the gRPC client. Since /api/zk/warmup already calls it on
    // dashboard load and the registry has been live for weeks, we drop it
    // from the prepare path entirely.
    const sponsorPromise = memoTtl(
      `onara:status:${onaraUrl}`,
      60_000,
      () => onaraClient.status()
    );
    // Gas price is per-epoch on Sui; a tight 1.5s memo window matches
    // the natural reorg + epoch boundary and is safe to cache for tx
    // building (the chain accepts a few seconds of staleness on the
    // reference gas price). Aggressive memo here saves ~150–300ms on
    // every send within the window.
    const gasPricePromise = memoTtl(
      `sui:gas-price:${net}`,
      1_500,
      async () => {
        const r = await client.getReferenceGasPrice();
        return r.referenceGasPrice;
      }
    );

    // Per-step timing inside the ptb window so a live send can pinpoint
    // where its cost actually goes: Payment Kit receipt append, the NAVI
    // supply leg, and the gas-price/onara round-trips below.
    const tStepStart = Date.now();
    let tPk = tStepStart;
    let tNavi = tStepStart;

    /**
     * Build the PTB body from scratch, with or without the Spend + Save leg.
     *
     * A function rather than straight-line code because the save leg has to
     * be DROPPABLE: if `appendNaviSupply` times out or throws, we rebuild
     * the body send-only rather than failing the payment. A Transaction that
     * already had a half-appended supply on it can't be reused, so each
     * attempt starts clean.
     */
    const buildBody = async (
      withSave: RoundupPlan | null
    ): Promise<{ tx: Transaction; nonce?: string }> => {
      const tx = new Transaction();
      tx.setSender(user.sui_address);

      if (asset !== "USDsui") {
        // SUI transfers can't use Payment Kit (registry is USDsui-only).
        // Use the legacy clock-MoveCall + split + transfer path.
        tx.moveCall({
          target: "0x2::clock::timestamp_ms",
          arguments: [tx.object("0x6")],
        });
        const coinType = COIN_TYPES.SUI;
        const out = tx.add(
          coinWithBalance({ type: coinType, balance: onchain, useGasCoin: false })
        );
        tx.transferObjects([out], to);
        tPk = tNavi = Date.now();
        return { tx };
      }

      const { nonce } = appendPaymentKitReceipt(tx, {
        kind: "send",
        sender: user.sui_address,
        receiver: to,
        amountUsdsui: amountNum,
      });
      tPk = Date.now();

      if (withSave) {
        // ── THE ATOMIC SAVE LEG ─────────────────────────────────────────
        // Same PTB, same signature, same digest as the transfer above. If
        // NAVI aborts, the transfer aborts with it, so the user can never
        // end up with a savings tally that has no money behind it.
        //
        // Deadline-bounded: `appendNaviSupply` does live pool/reserve/oracle
        // reads, and on an unwarmed lambda the first one measured 3344ms
        // (268ms warmed). Bounding it is what guarantees a wedged NAVI
        // upstream degrades to "payment landed, no save" instead of a 500.
        await withDeadline(
          appendNaviSupply(tx, user.sui_address, withSave.grossUsd, {
            treasuryFeeBps: SAVE_TREASURY_FEE_BPS,
          }),
          NAVI_APPEND_DEADLINE_MS,
          "navi supply append"
        );
        // Tag the supply leg with a Payment Kit marker so the activity
        // classifier + any third-party indexer can recover "this was a save
        // into NAVI" authoritatively. Same digest, second PaymentRecord.
        appendPaymentKitReceipt(tx, {
          kind: "invest",
          sender: user.sui_address,
          refs: { venue: "navi" },
        });
      }
      tNavi = Date.now();
      return { tx, nonce };
    };

    // Decide whether the save leg goes in, then build. Both failure modes
    // (can't cover it, can't build it) drop the SAVE and keep the SEND.
    let savePlan: RoundupPlan | null = plan;
    let saveReason: string | undefined;
    if (plan) {
      const cover = await (coverPromise ?? Promise.resolve({ ok: true as const }));
      if (!cover.ok) {
        savePlan = null;
        saveReason = "reason" in cover ? cover.reason : undefined;
        console.warn(
          `${SAVE_LOG} save dropped for user=${userId}: ${saveReason ?? "insufficient balance"}`
        );
      }
    }
    let body: { tx: Transaction; nonce?: string };
    try {
      body = await buildBody(savePlan);
    } catch (err) {
      if (!savePlan) throw err;
      // The save leg is what failed. Rebuild send-only and report it, rather
      // than turning an optional 2% save into a failed payment.
      saveReason = `couldn't build the save leg: ${(err as Error).message}`;
      console.error(
        `${SAVE_LOG} SAVE_LEG_FAILED user=${userId} amount=${amountNum} gross=${savePlan.grossUsd}: ${(err as Error).message}`
      );
      savePlan = null;
      body = await buildBody(null);
    }
    const tx = body.tx;
    const receiptNonce = body.nonce;
    const tBuilt = Date.now();

    // Now wait on the parallel lookups.
    const [{ address: sponsor }, gasPrice] = await Promise.all([
      sponsorPromise,
      gasPricePromise,
    ]);
    const tStatus = Date.now();

    tx.setGasOwner(sponsor);
    // Pre-set gas price so `tx.build()` skips its own
    // `getReferenceGasPrice` RPC.
    tx.setGasPrice(BigInt(gasPrice));

    // Explicit gas budget, load-bearing. Without it, tx.build() auto-selects
    // the sponsor's gas coins AND auto-estimates the budget. When the sponsor
    // holds a tiny "dust" Coin<SUI> alongside its main coin, the auto-selection
    // can pick ONLY the dust coin and then bake a budget that the dust can't
    // cover, so Onara's simulate rejects the signed tx with "Insufficient gas"
    // (a real send-killer observed in prod 2026-06-19). Setting a generous
    // fixed budget makes the SDK's gas-coin selection accumulate coins until
    // they total >= the budget, which pulls in the sponsor's main coin, so
    // gas is always sufficient regardless of dust. The sponsor is only charged
    // the ACTUAL gas used (~0.003–0.01 SUI); this is just the cap.
    tx.setGasBudget(SPONSOR_GAS_BUDGET_MIST);

    const bytes = await tx.build({ client: client as never });
    const tBuild = Date.now();

    // ── The save proof ──────────────────────────────────────────────────
    // A Sui digest is a hash of these exact TransactionData bytes, so we know
    // the digest this transaction WILL have before anyone signs it. Binding
    // the round-up amount to that digest under an HMAC is what lets
    // sponsor-execute credit the tally without trusting a single number from
    // the client, and what makes it impossible to point the credit at any
    // other transaction. See lib/rewards/roundup.ts.
    let save: SavePayload = savePlan
      ? {
          applied: true,
          grossUsd: savePlan.grossUsd,
          netUsd: savePlan.netUsd,
          feeBps: savePlan.feeBps,
          venue: "navi",
          proof: issueSaveProof({
            userId,
            digest: TransactionDataBuilder.getDigestFromBytes(bytes),
            plan: savePlan,
          }),
        }
      : noSave(saveReason);
    // Belt and braces: a proof we failed to mint means a save we cannot ever
    // credit, so report it as not applied rather than let the client paint a
    // green line over it. (The supply leg IS in the bytes and the money will
    // move; we simply refuse to claim a tally we can't prove.)
    if (save.applied && !save.proof) {
      save = noSave("save proof could not be issued");
    }
    if (savePlan) {
      console.log(
        `${SAVE_LOG} atomic PTB user=${userId} send=${amountNum} ` +
          `gross=${savePlan.grossUsd} net=${savePlan.netUsd} pct=${savePlan.percentage}%`
      );
    }

    console.log(
      `[send/sponsor-prepare] ptb=${tBuilt - t0}ms ` +
        `(pk=${tPk - tStepStart}ms navi=${tNavi - tPk}ms) ` +
        `· status+price(par)=${tStatus - tBuilt}ms ` +
        `· tx.build=${tBuild - tStatus}ms · total=${tBuild - t0}ms ` +
        `· save=${save.applied ? `$${save.netUsd}` : `none${saveReason ? ` (${saveReason})` : ""}`}`
    );
    // Mode label distinguishes the regular sponsored path from the
    // gasless-failure fall-through (Coin-only balance state) and from a
    // Save-ON send, which is sponsored BY DESIGN rather than as a fallback.
    // Clients only branch on `mode === "gasless"`, so a new label is safe.
    const effectiveMode = gaslessFellBack
      ? gaslessFellBackReason === "anchor"
        ? "sponsored-anchor-fallback"
        : "sponsored-coin-fallback"
      : save.applied
        ? "sponsored-save"
        : "sponsored";
    recordSendLatency({
      leg: "prepare",
      totalMs: tBuild - t0,
      atMs: Date.now(),
      extras: {
        mode: effectiveMode,
        ptbMs: tBuilt - t0,
        statusPriceMs: tStatus - tBuilt,
        txBuildMs: tBuild - tStatus,
        // The measured marginal cost of the atomic save leg. This is the
        // number to watch: if `naviMs` ever creeps toward
        // NAVI_APPEND_DEADLINE_MS in production, the warm in /api/zk/warmup
        // has stopped working.
        naviMs: tNavi - tPk,
        hasRoundup: save.applied,
      },
    });

    // Reserve against the rolling limit window (USDsui only, the cap
    // engine is fiat-USD today). Mirrors the gasless branch above:
    // best-effort, never gates the response.
    if (asset === "USDsui") {
      void recordSend({ userId, amountUsd: amountNum, asset, digest: null });
    }

    return NextResponse.json({
      bytes: toBase64(bytes),
      mode: effectiveMode,
      asset,
      amount: amountNum,
      to,
      receiptNonce,
      // The Spend + Save leg. `applied` is the truth about these exact bytes:
      // true means the NAVI supply is IN the transaction the client is about
      // to sign, false (with a `reason` when the user has round-up on) means
      // it is not and the receipt must not claim a save.
      save,
      // DEPRECATED, always 0. Pre-atomic clients read a non-zero
      // `roundupUsd` as "now fire the standalone save transaction"; the save
      // is inside these bytes, so telling them a number would save twice.
      // New clients read `save`.
      roundupUsd: 0,
    });
  } catch (err) {
    const msg = (err as Error).message ?? "build failed";
    console.warn(`[send/sponsor-prepare] user=${userId} failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
