import "server-only";

import { db, ensureSchema, type User } from "@/lib/db";
import { awardForTx, POINT_RATES } from "@/lib/rewards/earn";
import { claimAward } from "@/lib/rewards/integrity";
import {
  taliseTreasuryAddress,
  verifyDigestForUser,
} from "@/lib/rewards/verify";
import { sign as hmacSign, verify as hmacVerify } from "@/lib/auth";
import { invalidate } from "@/lib/perf-cache";

/**
 * Spend + Save, ONE ATOMIC PTB.
 *
 * ── The shape ────────────────────────────────────────────────────────
 *
 * Round-up ON  → the send is routed onto the SPONSORED rail and a single
 *                PTB carries BOTH legs: the Payment Kit transfer AND
 *                `appendNaviSupply` for `percentage%` of the amount. One
 *                user signature, one digest, atomic. If the save leg
 *                aborts, the send aborts with it.
 * Round-up OFF → nothing changes: the ordinary gasless send.
 *
 * There is no queue, no cron, no intent/token state machine and no
 * second transaction. The send's own confirmed digest IS the proof of
 * the save, because the save is inside it.
 *
 * ── Why the 2026-06-22 decoupling is reversed ────────────────────────
 *
 * `ae578f42` removed `appendNaviSupply` from this send's PTB with the note
 * "that combined shared-object PTB blew the sponsor window (send+save
 * timed out) even though a STANDALONE NAVI supply sponsors cleanly". Two
 * things are worth being precise about, because the obvious reading of
 * that note is wrong and it cost the feature a month of being fake.
 *
 * It was NOT removed from the gasless rail. The diff took it out of the
 * SPONSORED Payment Kit branch, the one that sets `setGasOwner(sponsor)`,
 * a real `gasPrice`, a 0.06 SUI `gasBudget` and runs a full
 * `tx.build({client})`. So "give it a real gas budget and shared-object
 * support" was never the missing ingredient: it already had both.
 *
 * And it was not the transaction's shape either. MEASURED on mainnet
 * (2026-07-25, scripts/probes/probe-spend-save-latency.mjs):
 *
 *   send-only PTB   5 commands,  815 B, simulate SUCCESS, gas 0.0056 SUI
 *   send+save PTB  11 commands, 1581 B, simulate SUCCESS, gas 0.0182 SUI
 *
 * The combined transaction executes fine and uses under a third of the
 * gas budget it is given. `tx.build()` costs the same either way
 * (747-811ms with the save leg vs 961-1038ms without: no penalty).
 *
 * What actually cost seconds was PREPARE-TIME LATENCY, and it hid in a
 * place nobody was looking: `NaviAdapter.init()` is lazy and returns in
 * 0 ms, so the `initNaviAdapter()` "pre-warm" wired into `/api/zk/warmup`
 * warmed NOTHING. All the pool/reserve/oracle metadata was fetched on the
 * first `addSaveToTx` — inside the user's send — at 3344 ms in a fresh
 * lambda, stacked on top of a cold Onara `/status` (3760 ms) and the
 * build (~1 s). Standalone "sponsored cleanly" only because it paid that
 * same cost in a request of its own, with its own budget.
 *
 * So this rebuild fixes the cause instead of the symptom:
 *
 *   • `initNaviAdapter()` now forces the lazy fetch by building a
 *     throwaway supply, which takes the first real send from 3344 ms to
 *     268 ms (p50 262 / p95 558 warm).
 *   • `/api/send/sponsor-prepare` gives the NAVI leg a HARD DEADLINE. If
 *     it can't be appended in time, the route builds a send-only PTB and
 *     reports the save as not applied. The payment can therefore never
 *     fail because of the round-up, which is the one thing the old
 *     bundled version got wrong and the reason it had to be ripped out.
 *
 * ── How the savings tally is proven ─────────────────────────────────
 *
 * `users.roundup_saved_usd` may ONLY move for a save that landed on
 * chain. It never moves from anything in a request body. Two independent
 * server-side facts are required, and the credited figure is the MINIMUM
 * of both:
 *
 *   1. A SAVE PROOF: an HMAC-signed token minted by the prepare route,
 *      over `(userId, digest, gross, net)`, where `digest` is the digest
 *      the PTB it just built WILL have (a Sui digest is a hash of the
 *      TransactionData bytes, so it is known before anyone signs). The
 *      client carries this token but cannot author or alter it, and it
 *      only matches the one transaction it was minted for.
 *   2. A CHAIN READ of that digest via `verifyDigestForUser`: the tx must
 *      have succeeded, been sent by this user, moved USD stablecoin OUT,
 *      paid the save fee to the Talise treasury (the fee leg only exists
 *      in a save PTB), and left `outflow − everything address-owned
 *      counterparties received` on the table. That remainder is money
 *      that left the wallet and reached no address at all, i.e. it went
 *      into a shared object: the NAVI reserve. It is the on-chain
 *      fingerprint of the supply and it is the hard ceiling on what we
 *      will ever call "saved".
 *
 * ── Idempotency ─────────────────────────────────────────────────────
 *
 * One send credits the tally at most once, enforced by the claim-ledger
 * pattern in `lib/rewards/integrity.ts`: `claimAward` takes a UNIQUE
 * `claim_key` (`save-tally:<user>:<digest>`) and only the caller that
 * wins the insert bumps the tally. Retries, duplicate confirms and two
 * concurrent lambdas all collapse onto one credit.
 */

// ─── Product gate (FAIL CLOSED) ──────────────────────────────────────

/**
 * Spend + Save product gate.
 *
 * FAIL CLOSED: Round-up is live ONLY when `ROUNDUP_ENABLED` is explicitly an
 * affirmative value, matching `cashoutOpen()` in lib/offramp/config.ts. An
 * unset, misspelled or migration-lost env var leaves the feature OFF, which is
 * the safe direction: a wrongly-closed round-up costs a user nothing, a
 * wrongly-open one shows them a savings figure with no money behind it.
 *
 * IMPORTANT: this NEVER writes to `users.roundup_enabled`. Each user's stored
 * preference is left exactly as they set it, so flipping the env var back on
 * restores every account to the percentage it chose, with its saved tally
 * intact. The gate is applied at READ time, in `getRoundupConfig`, which is the
 * single place both the send-prepare routes and the Rewards card get the
 * toggle from, so gating there covers every consumer at once.
 */
export function roundupFeatureEnabled(): boolean {
  const v = process.env.ROUNDUP_ENABLED?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

// ─── Policy ──────────────────────────────────────────────────────────

/** Log prefix for every line this feature writes. Grep this. */
export const LOG = "[spend-save]";

/**
 * Save / spend-and-save treasury fee, in basis points (100 = 1%).
 *
 * Duplicated from `lib/navi-supply.ts → SAVE_TREASURY_FEE_BPS` rather than
 * imported, for the same reason `lib/rewards/verify.ts` duplicates the
 * treasury address: importing `lib/navi-supply` drags the NAVI adapter (and
 * the Pyth SDK it delegates to) into the module graph, and this module is
 * reachable from `/api/referral/summary`, a fast-load read path that must
 * never pay for the NAVI SDK. The two constants must stay in step; the
 * on-chain fee is the one in `lib/navi-supply.ts`.
 */
const SAVE_TREASURY_FEE_BPS = 100;

/**
 * Smallest round-up worth putting in a PTB, in USD reaching NAVI.
 *
 * $0.005 (lowered from $0.01 on 2026-07-25). The old cent floor was set from
 * the rewards engine's `MIN_CREDITED_USD` and quietly made Spend + Save
 * unreachable for Talise's actual market: a ₦200 send is ~$0.15, so a 5%
 * round-up is $0.0073 and every such send skipped the save. A user with a
 * fixed percentage saw the feature fire or not fire purely on send size, with
 * no explanation.
 *
 * At $0.005 a 5% round-up qualifies from a ~$0.10 send, which covers ordinary
 * naira amounts. The 1% treasury fee on a $0.005 save is $0.00005, so the
 * supply is still worth more than it costs to take.
 *
 * A send whose round-up lands under this floor still gets NO save leg, but it
 * now reports `below_minimum` so the client can say why instead of showing a
 * bare success. Note points may round to nothing below the engine's own
 * `MIN_CREDITED_USD`; the money still reaches NAVI, which is the point.
 */
export const ROUNDUP_MIN_SAVE_USD = 0.005;

/**
 * Hard ceiling on a single round-up, in USD.
 *
 * Mirrors the rewards engine's per-award `ASSERTED_CEILING_USD`: above it
 * nothing further can be credited anyway, so promising a bigger save would
 * be a promise the tally cannot honour.
 */
const ROUNDUP_MAX_SAVE_USD = 10_000;

/** How long a save proof stays valid. A send that takes longer has failed. */
const PROOF_TTL_MS = 30 * 60 * 1000;

/** Points-per-USD for roundups. Re-export of the rewards engine's rate. */
export const ROUNDUP_POINTS_PER_USD = POINT_RATES.roundup;

/** Round-up net of the save treasury fee: what actually reaches NAVI. */
export function netSavedUsd(grossUsd: number): number {
  const net = grossUsd * (1 - SAVE_TREASURY_FEE_BPS / 10_000);
  // 6dp is USDsui's on-chain precision; anything finer is not a number the
  // chain can express.
  return Math.floor(net * 1e6) / 1e6;
}

// ─── Config ──────────────────────────────────────────────────────────

/**
 * Read the current round-up config for a user. Used by the
 * `/api/rewards/roundup` GET handler, `/api/referral/summary` (the Rewards
 * card) and the send-prepare routes (to decide whether to append the supply
 * leg).
 *
 * Gated by `roundupFeatureEnabled()`: when the product gate is off this
 * reports `enabled: false` for EVERY user, so no send takes the round-up path
 * and no receipt can claim a save. The user's stored `roundup_enabled` and
 * `roundup_percentage` are read but not written, and `savedUsd` still returns
 * the real tally so nobody's savings history disappears while the feature is
 * gated.
 */
export async function getRoundupConfig(userId: number): Promise<{
  enabled: boolean;
  percentage: number;
  savedUsd: number;
}> {
  await ensureSchema();
  const r = await db().execute({
    sql: `SELECT roundup_enabled, roundup_percentage, roundup_saved_usd
          FROM users WHERE id = ? LIMIT 1`,
    args: [userId],
  });
  const row = r.rows[0] as unknown as
    | (Partial<User> & { roundup_saved_usd?: number | null })
    | undefined;
  const storedEnabled = Number(row?.roundup_enabled ?? 0) === 1;
  return {
    enabled: roundupFeatureEnabled() && storedEnabled,
    percentage: clamp(Number(row?.roundup_percentage ?? 2) || 2, 1, 10),
    savedUsd: Number(row?.roundup_saved_usd ?? 0) || 0,
  };
}

/**
 * Update the round-up config. Either field is optional, missing
 * fields are left untouched.
 *
 * Deliberately NOT gated: a user's stored preference is theirs to set even
 * while the product gate is closed, and preserving it is the whole point of
 * gating at read time. The returned shape comes from `getRoundupConfig`, so a
 * toggle flipped on while the gate is closed echoes back `enabled: false` and
 * the UI tells the truth rather than promising a save that will not happen.
 *
 * Returns the post-update shape so the
 * caller can echo it back to the client without a second round-trip.
 */
/**
 * Memo key for a user's round-up config on the send path.
 *
 * Exported so `sponsor-prepare` (the reader) and `setRoundupConfig` (the
 * invalidator) cannot drift apart. A silent mismatch here reintroduces the
 * "toggle ignored for 60s" bug, which looks like Spend + Save being broken.
 */
export function roundupConfigMemoKey(userId: number): string {
  return `roundup:cfg:${userId}`;
}

export async function setRoundupConfig(opts: {
  userId: number;
  enabled?: boolean;
  percentage?: number;
}): Promise<{ enabled: boolean; percentage: number; savedUsd: number }> {
  await ensureSchema();
  const c = db();

  // Build the UPDATE dynamically, only touch the columns the caller
  // actually supplied. Avoids stomping the user's saved % to default
  // when they only toggled the switch.
  const sets: string[] = [];
  const args: (string | number)[] = [];
  if (opts.enabled !== undefined) {
    sets.push("roundup_enabled = ?");
    args.push(opts.enabled ? 1 : 0);
  }
  if (opts.percentage !== undefined) {
    sets.push("roundup_percentage = ?");
    args.push(clamp(opts.percentage, 1, 10));
  }
  if (sets.length > 0) {
    args.push(opts.userId);
    await c.execute({
      sql: `UPDATE users SET ${sets.join(", ")} WHERE id = ?`,
      args,
    });
    // Drop the send path's 60s memo of this user's config, or the toggle they
    // just flipped is ignored for up to a minute. That window is why testing
    // Spend + Save felt erratic: enable it, send straight away, and
    // sponsor-prepare read the CACHED "disabled" value, took the gasless rail
    // and skipped the save with no explanation.
    //
    // Key must stay in step with `roundup:cfg:${userId}` in
    // app/api/send/sponsor-prepare/route.ts. Best-effort: the memo is
    // per-lambda, so this clears the instance that served the write; other
    // instances still expire on their own TTL, which is the pre-existing
    // behaviour and self-heals within 60s.
    invalidate(roundupConfigMemoKey(opts.userId));
  }

  return getRoundupConfig(opts.userId);
}

// ─── Planning ────────────────────────────────────────────────────────

export type RoundupPlan = {
  /** Round-up leaving the wallet, in USDsui. */
  grossUsd: number;
  /** What reaches NAVI (gross minus the save treasury fee). */
  netUsd: number;
  /** Percentage the user has configured (1-10). */
  percentage: number;
  /** Treasury fee applied to the supply leg, in basis points. */
  feeBps: number;
};

/**
 * What Spend + Save should do for one send, computed entirely server-side
 * from the user's stored config. Returns null when there is no save to
 * make: the toggle is off, or the round-up is below the floor.
 *
 * The client never states a round-up amount anywhere in the flow.
 */
export function planRoundup(opts: {
  config: { enabled: boolean; percentage: number };
  sendAmountUsd: number;
}): RoundupPlan | null {
  const { enabled, percentage } = opts.config;
  if (!enabled) return null;
  const pct = clamp(percentage, 1, 10);
  if (!(opts.sendAmountUsd > 0)) return null;

  // Never round up more than the send itself, and never past the ceiling
  // above which nothing more can be credited.
  const raw = Math.min(
    (opts.sendAmountUsd * pct) / 100,
    opts.sendAmountUsd,
    ROUNDUP_MAX_SAVE_USD
  );
  // 6dp is USDsui's on-chain precision.
  const grossUsd = Math.floor(raw * 1e6) / 1e6;
  const netUsd = netSavedUsd(grossUsd);
  if (!(netUsd >= ROUNDUP_MIN_SAVE_USD)) return null;
  return { grossUsd, netUsd, percentage: pct, feeBps: SAVE_TREASURY_FEE_BPS };
}

// ─── Save proof ──────────────────────────────────────────────────────

/**
 * Mint the save proof for a built-and-sponsored send PTB.
 *
 * `digest` is `TransactionDataBuilder.getDigestFromBytes(bytes)`, the digest
 * the transaction we just built WILL have once signed. HMAC-signed with
 * `SESSION_SECRET` (via lib/auth), so the client can carry it but cannot
 * author one, cannot change the amount inside it, and cannot point it at a
 * different transaction.
 */
export function issueSaveProof(opts: {
  userId: number;
  digest: string;
  plan: RoundupPlan;
}): string {
  const payload = [
    "sns1",
    String(opts.userId),
    opts.digest,
    opts.plan.grossUsd.toFixed(6),
    opts.plan.netUsd.toFixed(6),
    String(Date.now()),
  ].join("|");
  return hmacSign(payload);
}

export type SaveProof = {
  userId: number;
  digest: string;
  grossUsd: number;
  netUsd: number;
  issuedAtMs: number;
};

/** Verify + parse a save proof. Returns null for anything not ours. */
export function readSaveProof(token: string | undefined | null): SaveProof | null {
  if (typeof token !== "string" || token.length === 0) return null;
  let payload: string | null = null;
  try {
    payload = hmacVerify(token);
  } catch {
    // SESSION_SECRET missing/short. Fail closed: no proof, no credit.
    return null;
  }
  if (!payload) return null;
  const parts = payload.split("|");
  if (parts.length !== 6 || parts[0] !== "sns1") return null;
  const userId = Number(parts[1]);
  const digest = parts[2];
  const grossUsd = Number(parts[3]);
  const netUsd = Number(parts[4]);
  const issuedAtMs = Number(parts[5]);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!digest) return null;
  if (!(grossUsd > 0) || !(netUsd > 0)) return null;
  if (!Number.isFinite(issuedAtMs)) return null;
  if (Date.now() - issuedAtMs > PROOF_TTL_MS) return null;
  return { userId, digest, grossUsd, netUsd, issuedAtMs };
}

// ─── Settlement ──────────────────────────────────────────────────────

export type SaveOutcome =
  /** Chain-verified. `savedUsd` hit `users.roundup_saved_usd`. */
  | { status: "saved"; savedUsd: number; digest: string }
  /**
   * The transaction is out but this server cannot read it back yet
   * (fullnode indexing lag). Nothing credited. The client may retry
   * `/api/send/save-confirm` with the same proof; the credit is
   * idempotent, so a retry can only ever add the one save.
   */
  | { status: "pending"; savedUsd: 0; digest: string; reason: string }
  /** Terminal. Nothing credited, ever. */
  | { status: "failed"; savedUsd: 0; digest: string; reason: string };

/**
 * Credit the savings tally for a send whose PTB carried the save leg.
 *
 * The ONLY path that moves `users.roundup_saved_usd`. Fails closed at
 * every step: no valid proof, no proof/digest match, no successful chain
 * read, no treasury fee leg, or no money into a non-address sink all mean
 * "not saved", and the tally does not move.
 */
export async function creditRoundupSave(opts: {
  userId: number;
  senderAddress: string;
  /** The digest Onara/the fullnode actually returned for the send. */
  digest: string;
  /** The proof minted by the prepare route for THIS send. */
  proofToken: string | undefined | null;
  /**
   * How many extra chain reads to spend waiting out fullnode indexing lag.
   * The sponsored broadcast waits for execution, but the read path can
   * still be a beat behind.
   */
  verifyRetries?: number;
}): Promise<SaveOutcome> {
  const digest = opts.digest ?? "";
  const proof = readSaveProof(opts.proofToken);
  if (!proof) {
    return {
      status: "failed",
      savedUsd: 0,
      digest,
      reason: "no valid save proof for this send",
    };
  }
  if (proof.userId !== opts.userId) {
    console.error(
      `${LOG} REFUSED proof user=${proof.userId} presented by user=${opts.userId}`
    );
    return {
      status: "failed",
      savedUsd: 0,
      digest,
      reason: "save proof belongs to another account",
    };
  }
  if (!digest || digest !== proof.digest) {
    // The transaction that executed is not the one we built the save into.
    console.error(
      `${LOG} REFUSED user=${opts.userId} broadcast=${digest} != prepared=${proof.digest}`
    );
    return {
      status: "failed",
      savedUsd: 0,
      digest,
      reason: "the executed transaction is not the one the save was built into",
    };
  }

  // ── Chain read ────────────────────────────────────────────────────
  const retries = Math.max(0, Math.min(opts.verifyRetries ?? 0, 3));
  let last: Awaited<ReturnType<typeof verifyDigestForUser>> | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1_200);
    last = await verifyDigestForUser({
      digest,
      senderAddress: opts.senderAddress,
      direction: "out",
    });
    if (last.ok || !last.retryable) break;
  }
  if (!last) {
    return { status: "pending", savedUsd: 0, digest, reason: "not read yet" };
  }
  if (!last.ok) {
    const reason = `${last.reason}: ${last.detail}`;
    if (last.retryable) {
      console.log(`${LOG} not readable yet user=${opts.userId} ${digest} ${reason}`);
      return { status: "pending", savedUsd: 0, digest, reason };
    }
    console.error(`${LOG} SAVE_FAILED user=${opts.userId} ${digest} ${reason}`);
    return { status: "failed", savedUsd: 0, digest, reason };
  }

  // ── Shape gate: is the save leg actually in this transaction? ──────
  // A save PTB pays `feeBps` of the round-up to the Talise treasury and
  // supplies the remainder into NAVI's reserve, which is a SHARED object
  // and therefore has no `balanceChanges` owner. So:
  //
  //   outflow  = send + gross
  //   received = send (recipient) + fee (treasury)     ← address-owned only
  //   sink     = outflow − received = gross − fee = what reached NAVI
  //
  // `sink` is money that verifiably left this wallet and reached no address
  // at all. It is the ceiling on what we are willing to call "saved", and a
  // plain send with no save leg has a sink of zero.
  const treasury = taliseTreasuryAddress();
  const feeUsd = last.tx.receivedByUsd[treasury] ?? 0;
  const receivedUsd = Object.values(last.tx.receivedByUsd).reduce(
    (a, b) => a + b,
    0
  );
  const sinkUsd = Math.max(0, last.tx.amountUsd - receivedUsd);
  if (!(feeUsd > 0)) {
    const reason = "no save fee leg in this transaction";
    console.error(
      `${LOG} SAVE_FAILED user=${opts.userId} ${digest} ${reason} ` +
        `(outflow=${last.tx.amountUsd} received=${receivedUsd})`
    );
    return { status: "failed", savedUsd: 0, digest, reason };
  }

  // Credit the SMALLER of what the server promised and what the chain
  // shows reaching NAVI. Never the client's word, never the promise alone.
  const savedUsd = Math.floor(Math.min(proof.netUsd, sinkUsd) * 1e6) / 1e6;
  if (!(savedUsd >= ROUNDUP_MIN_SAVE_USD)) {
    const reason = `nothing reached NAVI (promised ${proof.netUsd}, on chain ${sinkUsd})`;
    console.error(`${LOG} SAVE_FAILED user=${opts.userId} ${digest} ${reason}`);
    return { status: "failed", savedUsd: 0, digest, reason };
  }

  // ── Idempotency ───────────────────────────────────────────────────
  // The claim-ledger pattern from lib/rewards/integrity.ts: a UNIQUE
  // `claim_key` decides who credits, so one send credits the tally at most
  // once no matter how many retries or concurrent lambdas arrive.
  //
  // Inserted ALREADY `settled` (not `pending`) on purpose: a pending row
  // would be picked up by `settlePendingAwards` in lib/rewards/earn.ts,
  // which would settle it as a points award and take the race this row
  // exists to win. `credited_usd` is left NULL so the row consumes ZERO
  // per-digest points headroom and `points` stays 0 — the round-up's
  // POINTS are awarded separately, by `awardForTx` below, under its own
  // `tx:<user>:<digest>:roundup` key. This row is purely the tally's
  // idempotency record; `asserted_usd` carries the credited savings for
  // audit.
  const claimed = await claimAward({
    userId: opts.userId,
    triggerKind: "roundup",
    claimKey: `save-tally:${opts.userId}:${digest}`,
    digest,
    assertedUsd: savedUsd,
    status: "settled",
  });
  if (!claimed) {
    console.log(`${LOG} already credited user=${opts.userId} ${digest}`);
    return { status: "saved", savedUsd, digest };
  }

  await db().execute({
    sql: `UPDATE users
          SET roundup_saved_usd = COALESCE(roundup_saved_usd, 0) + ?
          WHERE id = ?`,
    args: [savedUsd, opts.userId],
  });

  // Points + `users.lifetime_saved_usd`, on the chain-verified figure.
  // `awardForTx` re-reads the same digest itself and owns its own UNIQUE
  // claim key, so this is safe to reach twice and can never pay twice.
  // Deliberately not awaited into the caller's error path: the money moved
  // and the tally is already right, a points hiccup must not look like a
  // failed save.
  void awardForTx({
    userId: opts.userId,
    trigger: "roundup",
    amountUsd: savedUsd,
    digest,
    venue: "navi",
  }).catch((e) =>
    console.warn(`${LOG} award failed ${digest}: ${(e as Error).message}`)
  );

  console.log(
    `${LOG} SAVED user=${opts.userId} ${digest} promised=${proof.netUsd} ` +
      `onchain=${sinkUsd} fee=${feeUsd} credited=${savedUsd}`
  );
  return { status: "saved", savedUsd, digest };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
