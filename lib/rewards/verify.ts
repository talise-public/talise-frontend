import "server-only";

import { isUsdsui } from "@/lib/usdsui";

/**
 * Talise Rewards, ON-CHAIN AMOUNT VERIFICATION.
 *
 * ── Why this file exists ────────────────────────────────────────────
 *
 * Every points award used to be computed from `meta.amountUsd` in the
 * request body. `/api/zk/sponsor-execute`, `/api/send/gasless-submit`
 * and `/api/send/gasless-confirm` all read that field straight off the
 * client and passed it to `awardForTx`, clamped only by a 10,000 USD
 * per-call ceiling. That is a faucet, not a cap: a client can POST
 * `{ digest, meta: { kind: "invest", amountUsd: 10000 } }` as often as
 * it likes and mint 30,000 pts a shot without moving a cent. The same
 * class of bug already burned us once through the `goal` trigger (one
 * account rigged itself to 1,008,671,212 pts; see POINT_RATES.goal).
 *
 * So: a client-asserted amount is now only ever an *upper bound on a
 * request*, never a source of value. The value comes from here, the
 * chain, and nowhere else.
 *
 * ── What "verified" means ───────────────────────────────────────────
 *
 * For a digest to yield points it must satisfy ALL of:
 *
 *   1. It parses as a Sui digest (base58, 40-60 chars). Junk never
 *      reaches the RPC.
 *   2. The fullnode has it and `status === "success"`. An admitted-then-
 *      aborted tx carries a digest but moved no money.
 *   3. `tx.sender` equals the awarded user's own `sui_address`. This is
 *      the binding that stops a client from replaying a stranger's
 *      (or a whale's) digest into its own balance.
 *   4. The user's NET USD-stablecoin delta in that tx moves in the
 *      direction the trigger claims. Net, not gross: a self-transfer
 *      nets to ~zero and therefore earns nothing, which kills the
 *      cheapest wash-farm on a gasless rail.
 *
 * The returned `amountUsd` is the magnitude of that net delta (with one
 * documented fallback for cross-asset sends, below). Callers award on
 * `min(asserted, verified, per-digest headroom)`, so points can never
 * exceed money that actually moved.
 *
 * ── Cost + shape notes ──────────────────────────────────────────────
 *
 * `getNormalizedTransaction` (lib/sui-shapes.ts) is the repo's only
 * sanctioned digest reader and is what `/api/tx/record` uses for its
 * invoice check, same transport, same normalization, one gRPC call. It
 * is pulled in with a DYNAMIC import so that merely importing the
 * rewards engine (which `/api/referral/summary` does on a fast-load
 * path) doesn't drag the eagerly-constructed gRPC client into the
 * module graph.
 */

/** Sui tx digest: base58 of a 32-byte hash. Mirrors /api/tx/record. */
const DIGEST_RE = /^[1-9A-HJ-NP-Za-km-z]{40,60}$/;

/**
 * Native Circle USDC on Sui mainnet. Copied literally from
 * `lib/sui.ts → COIN_TYPES.USDC` rather than imported: importing
 * `lib/sui` eagerly builds the gRPC fallback proxy at module load, and
 * this module is reachable from the rewards-summary read path.
 */
const USDC_TYPE =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

/** USDsui and USDC are both 6-decimal. */
const USD_MICRO = 1_000_000;

/**
 * The Talise treasury wallet, i.e. the address our fee legs pay.
 *
 * Duplicated from `lib/navi-supply.ts → TREASURY_WALLET` (same env var, same
 * literal default) for the same reason `USDC_TYPE` above is duplicated from
 * `lib/sui.ts`: importing `lib/navi-supply` drags the NAVI adapter (and the
 * Pyth SDK it delegates to) into the module graph, and this module is
 * reachable from the rewards-summary fast-load read path.
 *
 * Read per call rather than at module load so a treasury rotation takes
 * effect on the next request instead of the next cold start.
 */
export function taliseTreasuryAddress(): string {
  return (
    process.env.TALISE_TREASURY_WALLET?.trim() ||
    "0xc0bf1c51e44f8cfa4a06f16a2408effa3507ac4582744c7ead56078b5e251a48"
  ).toLowerCase();
}

/** Hard ceiling on how long we'll wait for one digest read. */
const VERIFY_TIMEOUT_MS = 3_000;

function normalizeCoinType(t: string): string {
  const parts = t.split("::");
  if (parts.length !== 3) return t.toLowerCase();
  return `0x${parts[0].toLowerCase().replace(/^0x/, "")}::${parts[1]}::${parts[2]}`;
}

const USDC_NORMALIZED = normalizeCoinType(USDC_TYPE);

/** Is this coin type a USD stablecoin we're willing to price at 1:1? */
export function isUsdStable(coinType: string): boolean {
  if (isUsdsui(coinType)) return true;
  return normalizeCoinType(coinType) === USDC_NORMALIZED;
}

/** Which way the trigger claims money moved for the user. */
export type MoneyDirection = "out" | "in";

export type VerifiedTx = {
  digest: string;
  /**
   * Chain-verified USD magnitude in the requested direction. Always
   * >= 0; zero when the tx moved no USD stablecoin that way (e.g. a
   * self-transfer, or a "send" that was really an inbound receive).
   */
  amountUsd: number;
  /** Signed net USD delta for the user. Positive = received. */
  netUsd: number;
  /** Lowercased addresses that RECEIVED USD stablecoin in this tx. */
  recipients: string[];
  /**
   * USD stablecoin RECEIVED, per address-owned counterparty (lowercased
   * address → USD). Same population as `recipients`, with the amounts kept.
   *
   * `amountUsd` is a NET figure for the whole transaction, which is the right
   * basis for "how much did this user pay somebody". It is the wrong basis for
   * "how much did this user pay US": a PTB can move money to several places at
   * once (a NAVI supply sends the principal to the lending pool AND 1% to the
   * Talise treasury in one tx), so a trigger whose value is a FEE has to read
   * the fee leg specifically instead of the transaction total. See the
   * `perps_close` shape gate in lib/rewards/earn.ts.
   */
  receivedByUsd: Record<string, number>;
  timestampMs: number | null;
};

export type VerifyFailure =
  /** Fullnode hasn't indexed it yet, or the read failed. RETRY LATER. */
  | { ok: false; retryable: true; reason: "unavailable"; detail: string }
  /** Terminal: this digest will never be worth points for this user. */
  | {
      ok: false;
      retryable: false;
      reason:
        | "bad_digest"
        | "tx_failed"
        | "sender_mismatch"
        | "no_usd_movement"
        | "wrong_direction";
      detail: string;
    };

export type VerifyResult = { ok: true; tx: VerifiedTx } | VerifyFailure;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
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

/**
 * Read a digest from chain and reduce it to "how much USD did THIS user
 * move, in THIS direction". Fails closed: any outcome that isn't a clean
 * verified amount returns `ok: false`, and the caller must not award.
 */
export async function verifyDigestForUser(opts: {
  digest: string;
  /** The awarded user's own wallet address. Must equal the tx sender. */
  senderAddress: string;
  direction: MoneyDirection;
}): Promise<VerifyResult> {
  const digest = opts.digest?.trim() ?? "";
  if (!DIGEST_RE.test(digest)) {
    return {
      ok: false,
      retryable: false,
      reason: "bad_digest",
      detail: "digest is not 40-60 base58 chars",
    };
  }
  const sender = opts.senderAddress?.trim().toLowerCase() ?? "";
  if (!/^0x[a-f0-9]{64}$/.test(sender)) {
    // No trustworthy address to bind the digest to → nothing is verifiable.
    return {
      ok: false,
      retryable: false,
      reason: "sender_mismatch",
      detail: "user has no canonical sui_address",
    };
  }

  let tx: Awaited<
    ReturnType<
      typeof import("@/lib/sui-shapes")["getNormalizedTransaction"]
    >
  >;
  try {
    const { getNormalizedTransaction } = await import("@/lib/sui-shapes");
    tx = await withTimeout(
      getNormalizedTransaction(digest),
      VERIFY_TIMEOUT_MS,
      "rewards.verifyDigest"
    );
  } catch (e) {
    // Not-yet-indexed is the common case: the send rails broadcast with
    // `waitForExecution: false`, so the award fires before the fullnode
    // has the tx. Treat every read failure as retryable and let the
    // deferred-settlement pass pick it up.
    return {
      ok: false,
      retryable: true,
      reason: "unavailable",
      detail: (e as Error).message,
    };
  }

  if (tx.status !== "success") {
    return {
      ok: false,
      retryable: false,
      reason: "tx_failed",
      detail: `status=${tx.status}`,
    };
  }
  if ((tx.sender ?? "").toLowerCase() !== sender) {
    return {
      ok: false,
      retryable: false,
      reason: "sender_mismatch",
      detail: `tx sender ${tx.sender} != user ${sender}`,
    };
  }

  // NET delta for the user across every USD stablecoin in the tx, plus
  // the set of addresses that received stablecoin (used downstream to
  // spot referral money circling straight back to the inviter, and as the
  // cross-asset fallback below).
  //
  // Only ADDRESS-owned changes count as a counterparty. Shared/object
  // owners (AMM pools, escrows) have `ownerAddress === null` and are
  // excluded, so routing a swap through Cetus doesn't look like paying
  // somebody.
  let netMicro = 0n;
  let sawUsd = false;
  let othersReceivedMicro = 0n;
  const recipients = new Set<string>();
  const receivedMicroBy = new Map<string, bigint>();
  for (const c of tx.balanceChanges) {
    if (!isUsdStable(c.coinType)) continue;
    sawUsd = true;
    if (c.ownerAddress === sender) {
      netMicro += c.amount;
    } else if (c.amount > 0n && c.ownerAddress) {
      recipients.add(c.ownerAddress);
      othersReceivedMicro += c.amount;
      receivedMicroBy.set(
        c.ownerAddress,
        (receivedMicroBy.get(c.ownerAddress) ?? 0n) + c.amount
      );
    }
  }
  if (!sawUsd) {
    return {
      ok: false,
      retryable: false,
      reason: "no_usd_movement",
      detail: "no USDsui/USDC balance change in tx",
    };
  }

  const netUsd = Number(netMicro) / USD_MICRO;
  const wantOut = opts.direction === "out";
  let magnitude = wantOut ? -netUsd : netUsd;

  // Cross-asset send fallback. On a `send-cross-asset` PTB the user pays
  // in SUI and the RECIPIENT is credited USDsui, so the sender's own
  // stablecoin delta is >= 0 and the net-outflow rule above would score
  // it zero. When that happens, fall back to "USD stablecoin that
  // address-owned counterparties received in a transaction this user
  // sent". Still entirely chain-derived, still bound to the user as
  // sender, and still capped downstream by the client-asserted amount and
  // the per-digest headroom — it just uses the recipient's side of the
  // ledger instead of the payer's.
  if (wantOut && !(magnitude > 0) && othersReceivedMicro > 0n) {
    magnitude = Number(othersReceivedMicro) / USD_MICRO;
  }

  if (!(magnitude > 0)) {
    // A "send" whose net USD delta isn't negative (self-transfer, or a
    // receive mislabelled as a send) is worth nothing.
    return {
      ok: false,
      retryable: false,
      reason: "wrong_direction",
      detail: `netUsd=${netUsd} but direction=${opts.direction}`,
    };
  }

  const receivedByUsd: Record<string, number> = {};
  for (const [addr, micro] of receivedMicroBy) {
    receivedByUsd[addr] = Number(micro) / USD_MICRO;
  }

  return {
    ok: true,
    tx: {
      digest,
      amountUsd: magnitude,
      netUsd,
      recipients: Array.from(recipients),
      receivedByUsd,
      timestampMs: tx.timestampMs,
    },
  };
}

/**
 * Candidate digests for a DEFERRED award, i.e. one booked without a
 * digest at all.
 *
 * `/api/zk/sponsor-execute` calls `awardForTx({ ..., digest: undefined })`
 * — the comment there says "filled below once we extract it", and it
 * never is. That route is owned elsewhere, so rather than silently
 * dropping every sponsored send's points we book the award as PENDING
 * and later go looking for the transaction on chain ourselves.
 *
 * This returns recent digests the user's own address participated in,
 * newest first. Discovery only, nothing here is trusted: each candidate
 * still has to survive `verifyDigestForUser` before a single point is
 * minted, and each digest can only ever be claimed once (UNIQUE
 * `claim_key` in the award ledger).
 *
 * `complete: false` means the history read was partial. We refuse to
 * match against a partial view for the same reason lib/activity.ts
 * refuses to aggregate one: an incomplete read is not an empty one.
 */
export async function recentCandidateDigests(
  address: string,
  limit = 25
): Promise<{ digests: Array<{ digest: string; timestampMs: number }>; complete: boolean }> {
  if (!/^0x[a-fA-F0-9]{64}$/.test(address ?? "")) {
    return { digests: [], complete: false };
  }
  try {
    const { getRecentActivityWithMeta } = await import("@/lib/activity");
    const { entries, complete } = await withTimeout(
      getRecentActivityWithMeta(address, limit, { includeNonTalise: true }),
      8_000,
      "rewards.recentCandidateDigests"
    );
    const digests = entries
      .filter((e) => typeof e.digest === "string" && e.digest.length > 0)
      .map((e) => ({ digest: e.digest, timestampMs: e.timestampMs ?? 0 }))
      .sort((a, b) => b.timestampMs - a.timestampMs);
    return { digests, complete };
  } catch (e) {
    console.warn(
      `[rewards/verify] candidate discovery failed for ${address}: ${(e as Error).message}`
    );
    return { digests: [], complete: false };
  }
}
