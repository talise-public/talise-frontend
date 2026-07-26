import "server-only";

import { db, schemaVersionGate } from "@/lib/db";

/**
 * Talise Rewards, ISSUANCE INTEGRITY LAYER.
 *
 * Everything in this file exists to answer three questions that the
 * original rewards engine could not:
 *
 *   1. "Was this award already paid?"  → `rewards_award_ledger.claim_key`
 *      is UNIQUE, so every award is claimed exactly once no matter how
 *      many times a fire-and-forget route retries it.
 *   2. "How much real money backs this award?" → each row carries the
 *      chain-verified amount (`verified_usd`) alongside what the client
 *      asserted (`asserted_usd`), and points are only ever paid on
 *      `credited_usd <= verified_usd`.
 *   3. "Can we take it back?" → `rewards_integrity_audit` +
 *      `rewards_farming_flags` give a reversible, attributable clawback
 *      path instead of "points_total is whatever it is now".
 *
 * ── Why a side table instead of reading `rewards_events` ────────────
 *
 * `rewards_events` is an append-only DISPLAY feed: `kind TEXT`, `points
 * INTEGER`, free-form JSON metadata, no unique constraint on anything.
 * The old round-up dedupe had to do `metadata LIKE '%"digest":"…"%"'` to
 * guess whether it had already paid (lib/rewards/roundup.ts:102). That is
 * not an idempotency mechanism, it's a string search. This table is the
 * accounting record; `rewards_events` stays the feed.
 *
 * All DDL lives here behind `ensureRewardsIntegritySchema()` (same
 * `schemaVersionGate` pattern as lib/agent-wallets.ts) so `lib/db.ts`,
 * which other work streams own, is untouched.
 */

// ─── Schema ──────────────────────────────────────────────────────────

/** Bump when the DDL below changes. */
const SCHEMA_VERSION = "2026-07-25.1";

// NOTE: the column is `trigger_kind`, not `trigger`. `TRIGGER` is a
// reserved word in Postgres and an unquoted `trigger` column blows up
// the CREATE TABLE.
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS rewards_award_ledger (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id),
     trigger_kind TEXT NOT NULL,
     digest TEXT,
     claim_key TEXT NOT NULL UNIQUE,
     asserted_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
     verified_usd DOUBLE PRECISION,
     credited_usd DOUBLE PRECISION,
     qualifying_usd DOUBLE PRECISION,
     points INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL,
     reason TEXT,
     created_at BIGINT NOT NULL,
     settled_at BIGINT,
     clawed_back_at BIGINT
   )`,
  `CREATE INDEX IF NOT EXISTS rewards_award_ledger_user_status_idx
     ON rewards_award_ledger(user_id, status)`,
  `CREATE INDEX IF NOT EXISTS rewards_award_ledger_user_digest_idx
     ON rewards_award_ledger(user_id, digest)`,
  `CREATE INDEX IF NOT EXISTS rewards_award_ledger_kind_settled_idx
     ON rewards_award_ledger(user_id, trigger_kind, settled_at DESC)`,
  // Global digest→claim index: used to prove a digest has never been
  // paid to ANY account, which is what stops one wallet's transaction
  // from bankrolling several accounts' points.
  `CREATE INDEX IF NOT EXISTS rewards_award_ledger_digest_idx
     ON rewards_award_ledger(digest)`,

  `CREATE TABLE IF NOT EXISTS rewards_integrity_audit (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL,
     action TEXT NOT NULL,
     actor TEXT NOT NULL,
     reason TEXT NOT NULL,
     points_before INTEGER,
     points_after INTEGER,
     points_delta INTEGER,
     rows_affected INTEGER,
     metadata TEXT,
     idempotency_key TEXT UNIQUE,
     created_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS rewards_integrity_audit_user_idx
     ON rewards_integrity_audit(user_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS rewards_farming_flags (
     user_id INTEGER PRIMARY KEY,
     blocked INTEGER NOT NULL DEFAULT 1,
     reason TEXT NOT NULL,
     actor TEXT NOT NULL,
     created_at BIGINT NOT NULL,
     updated_at BIGINT NOT NULL
   )`,
];

let _ready: Promise<void> | null = null;

async function doEnsureSchema(): Promise<void> {
  const gate = await schemaVersionGate(
    "rewards_integrity_schema_version",
    SCHEMA_VERSION + DDL.join("|")
  );
  if (gate.upToDate) return;
  const c = db();
  for (const stmt of DDL) {
    await c.execute(stmt);
  }
  await gate.stamp();
}

export async function ensureRewardsIntegritySchema(): Promise<void> {
  if (!_ready) {
    _ready = doEnsureSchema().catch((e) => {
      _ready = null; // retry on next call rather than caching the failure
      throw e;
    });
  }
  return _ready;
}

// ─── Ledger ──────────────────────────────────────────────────────────

export type LedgerStatus =
  /** Booked, no points minted, waiting on chain verification. */
  | "pending"
  /** Verified + paid. `points` is what hit `users.points_total`. */
  | "settled"
  /** Terminally unverifiable (or policy-blocked). Never pays. */
  | "rejected"
  /** Pending for longer than PENDING_TTL_MS without ever verifying. */
  | "expired"
  /** Was settled, then reversed by an operator. */
  | "clawed_back";

/**
 * `trigger_kind` values. The money triggers mirror `EarnTrigger` in
 * lib/rewards/earn.ts; the rest are policy awards.
 */
export type LedgerTrigger =
  | "send"
  | "invest"
  | "withdraw"
  | "roundup"
  | "goal"
  | "swap"
  // Closing a WaterX perps position. Paid on the 2% close fee the user
  // actually delivered to the Talise treasury inside the close PTB — the only
  // part of a close that is visible in `balanceChanges` at all (realized PnL
  // and returned collateral settle into the Account object's internal credit
  // balance, not into a Coin). See PERPS_CLOSE in lib/rewards-constants.ts.
  | "perps_close"
  | "first_send"
  // Reserved: the handle-claim bonus (POINTS.FIRST_CLAIM) has no issuing
  // code path today. Listed so that when it gets one it lands in the
  // ledger and is covered by `clawbackUser({ scope: "policy" })`.
  | "first_claim"
  | "referral_activation";

export type LedgerRow = {
  id: number;
  user_id: number;
  trigger_kind: LedgerTrigger;
  digest: string | null;
  claim_key: string;
  asserted_usd: number;
  verified_usd: number | null;
  credited_usd: number | null;
  qualifying_usd: number | null;
  points: number;
  status: LedgerStatus;
  reason: string | null;
  created_at: number;
  settled_at: number | null;
  clawed_back_at: number | null;
};

function toRow(r: Record<string, unknown>): LedgerRow {
  return {
    id: Number(r.id),
    user_id: Number(r.user_id),
    trigger_kind: String(r.trigger_kind) as LedgerTrigger,
    digest: (r.digest as string | null) ?? null,
    claim_key: String(r.claim_key),
    asserted_usd: Number(r.asserted_usd ?? 0) || 0,
    verified_usd: r.verified_usd == null ? null : Number(r.verified_usd),
    credited_usd: r.credited_usd == null ? null : Number(r.credited_usd),
    qualifying_usd: r.qualifying_usd == null ? null : Number(r.qualifying_usd),
    points: Number(r.points ?? 0) || 0,
    status: String(r.status) as LedgerStatus,
    reason: (r.reason as string | null) ?? null,
    created_at: Number(r.created_at ?? 0) || 0,
    settled_at: r.settled_at == null ? null : Number(r.settled_at),
    clawed_back_at: r.clawed_back_at == null ? null : Number(r.clawed_back_at),
  };
}

/**
 * IDEMPOTENCY PRIMITIVE. Claim `claimKey` for this award.
 *
 * Returns the freshly-inserted row on a win, or `null` when some earlier
 * call already owns the key. Every points-minting path in the rewards
 * engine goes through here first, so a duplicate route call, a client
 * retry, or two concurrent lambdas can never double-credit: the UNIQUE
 * index on `claim_key` decides the winner and `RETURNING id` tells us
 * unambiguously whether we are it (postgres.js reports `count: 0` for a
 * DO NOTHING conflict, but RETURNING removes any doubt).
 */
export async function claimAward(opts: {
  userId: number;
  triggerKind: LedgerTrigger;
  claimKey: string;
  digest?: string | null;
  assertedUsd?: number;
  status?: LedgerStatus;
}): Promise<LedgerRow | null> {
  await ensureRewardsIntegritySchema();
  const now = Date.now();
  const r = await db().execute({
    sql: `INSERT INTO rewards_award_ledger
            (user_id, trigger_kind, digest, claim_key, asserted_usd,
             points, status, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?)
          ON CONFLICT (claim_key) DO NOTHING
          RETURNING *`,
    args: [
      opts.userId,
      opts.triggerKind,
      opts.digest ?? null,
      opts.claimKey,
      opts.assertedUsd ?? 0,
      opts.status ?? "pending",
      now,
    ],
  });
  const row = r.rows[0];
  return row ? toRow(row) : null;
}

/**
 * Mark a claimed row as paid. Does NOT touch `users.points_total`.
 *
 * Returns TRUE only for the caller that actually flipped the row out of
 * `pending`. Callers must gate the `rewards_events` write + the
 * `points_total` bump on that boolean: the claim key stops two awards
 * existing, but two concurrent SETTLEMENT passes over the same pending
 * row are entirely possible (a send and an app-open landing together),
 * and without this they'd each mint the points once.
 */
export async function markSettled(opts: {
  id: number;
  verifiedUsd: number;
  creditedUsd: number;
  qualifyingUsd?: number | null;
  points: number;
  reason?: string | null;
}): Promise<boolean> {
  const r = await db().execute({
    sql: `UPDATE rewards_award_ledger
          SET status = 'settled', verified_usd = ?, credited_usd = ?,
              qualifying_usd = ?, points = ?, reason = ?, settled_at = ?
          WHERE id = ? AND status = 'pending'
          RETURNING id`,
    args: [
      opts.verifiedUsd,
      opts.creditedUsd,
      opts.qualifyingUsd ?? null,
      opts.points,
      opts.reason ?? null,
      Date.now(),
      opts.id,
    ],
  });
  return r.rows.length > 0;
}

/** Close a claimed row out without paying. Terminal. */
export async function markRejected(
  id: number,
  reason: string,
  status: Extract<LedgerStatus, "rejected" | "expired"> = "rejected"
): Promise<void> {
  await db().execute({
    sql: `UPDATE rewards_award_ledger
          SET status = ?, reason = ?, settled_at = ?
          WHERE id = ? AND status = 'pending'`,
    args: [status, reason.slice(0, 300), Date.now(), id],
  });
}

/** Attach a discovered digest to a deferred (digest-less) pending row. */
export async function attachDigest(id: number, digest: string): Promise<void> {
  await db().execute({
    sql: `UPDATE rewards_award_ledger SET digest = ?
          WHERE id = ? AND digest IS NULL`,
    args: [digest, id],
  });
}

export async function pendingAwards(
  userId: number,
  limit = 10
): Promise<LedgerRow[]> {
  await ensureRewardsIntegritySchema();
  const r = await db().execute({
    sql: `SELECT * FROM rewards_award_ledger
          WHERE user_id = ? AND status = 'pending'
          ORDER BY created_at ASC
          LIMIT ?`,
    args: [userId, limit],
  });
  return r.rows.map(toRow);
}

/**
 * What has already been paid against `digest`, across ALL accounts.
 *
 * Two independent guards come out of this:
 *   • `creditedUsd`, the USD already turned into points for this digest.
 *     A digest can never fund more points-USD than it actually moved,
 *     even across several triggers.
 *   • `triggers` / `otherUserIds`, so we can refuse a second PRIMARY
 *     trigger on one digest (rate stacking: the same $100 send claimed
 *     as send+invest+swap would pay 1+3+1 pts/$ instead of 1) and refuse
 *     a digest that already funded a different account.
 */
export async function digestUsage(digest: string): Promise<{
  creditedUsd: number;
  triggers: LedgerTrigger[];
  userIds: number[];
}> {
  await ensureRewardsIntegritySchema();
  // Policy awards (`first_send`, `first_claim`, `referral_activation`) are stamped with
  // the digest that triggered them purely as an audit link, and the
  // inviter's activation row hangs off the REFEREE's digest. They are
  // excluded here so that link can't be misread as "this digest already
  // paid another account" or as consumed USD headroom.
  const r = await db().execute({
    sql: `SELECT user_id, trigger_kind, COALESCE(credited_usd, 0) AS credited_usd
          FROM rewards_award_ledger
          WHERE digest = ? AND status IN ('settled', 'clawed_back')
            AND trigger_kind NOT IN ('first_send', 'first_claim', 'referral_activation')`,
    args: [digest],
  });
  let creditedUsd = 0;
  const triggers: LedgerTrigger[] = [];
  const userIds = new Set<number>();
  for (const row of r.rows) {
    creditedUsd += Number(row.credited_usd ?? 0) || 0;
    triggers.push(String(row.trigger_kind) as LedgerTrigger);
    userIds.add(Number(row.user_id));
  }
  return { creditedUsd, triggers, userIds: Array.from(userIds) };
}

/**
 * Is this digest already spoken for by a live ledger row (pending
 * included) carrying one of `blockingTriggers`?
 *
 * `digestUsage` only counts rows that were actually PAID, which is right
 * for headroom accounting but wrong for deferred matching: a digest a
 * still-pending award has reserved must not be handed to a second award
 * as well. Rejected/expired rows release their digest.
 *
 * The trigger list matters. A Spend-and-Save PTB legitimately produces
 * two awards under one digest (the send leg and the round-up leg), so
 * "reserved" has to mean "reserved by something in the same exclusivity
 * class", not "mentioned anywhere".
 */
export async function digestReserved(
  digest: string,
  blockingTriggers: ReadonlyArray<string>
): Promise<boolean> {
  await ensureRewardsIntegritySchema();
  if (blockingTriggers.length === 0) return false;
  const r = await db().execute({
    sql: `SELECT 1 FROM rewards_award_ledger
          WHERE digest = ? AND status IN ('pending', 'settled', 'clawed_back')
            AND trigger_kind IN (${blockingTriggers.map(() => "?").join(", ")})
          LIMIT 1`,
    args: [digest, ...blockingTriggers],
  });
  return r.rows.length > 0;
}

/** UTC midnight for `at` (default now). Day boundary for all daily caps. */
export function utcDayStart(at = Date.now()): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Points paid to this user for MONEY actions since `sinceMs`.
 *
 * Policy awards are excluded so `DAILY_EARN_POINTS_CAP` measures what it
 * claims to (wash-trading headroom) and a one-off referral activation
 * can't eat a legitimate day's send earnings. Referral volume has its own
 * caps in `REFERRAL_LIMITS`.
 */
export async function moneyPointsSettledSince(
  userId: number,
  sinceMs: number
): Promise<number> {
  await ensureRewardsIntegritySchema();
  const r = await db().execute({
    sql: `SELECT COALESCE(SUM(points), 0) AS pts
          FROM rewards_award_ledger
          WHERE user_id = ? AND status = 'settled' AND settled_at >= ?
            AND trigger_kind NOT IN ('first_send', 'first_claim', 'referral_activation')`,
    args: [userId, sinceMs],
  });
  return Number(r.rows[0]?.pts ?? 0) || 0;
}

/**
 * Chain-verified USD this user has moved that COUNTS toward referral
 * qualification. `qualifying_usd` is deliberately narrower than
 * `verified_usd`: money that flowed straight back to the user's own
 * inviter doesn't qualify (see lib/rewards/referral.ts).
 */
export async function qualifyingUsdTotal(userId: number): Promise<number> {
  await ensureRewardsIntegritySchema();
  const r = await db().execute({
    sql: `SELECT COALESCE(SUM(qualifying_usd), 0) AS usd
          FROM rewards_award_ledger
          WHERE user_id = ? AND status = 'settled'`,
    args: [userId],
  });
  return Number(r.rows[0]?.usd ?? 0) || 0;
}

/** Count settled awards of one kind, optionally within a window. */
export async function countSettled(
  userId: number,
  triggerKind: LedgerTrigger,
  sinceMs?: number
): Promise<number> {
  await ensureRewardsIntegritySchema();
  const r = sinceMs
    ? await db().execute({
        sql: `SELECT COUNT(*) AS n FROM rewards_award_ledger
              WHERE user_id = ? AND trigger_kind = ? AND status = 'settled'
                AND settled_at >= ?`,
        args: [userId, triggerKind, sinceMs],
      })
    : await db().execute({
        sql: `SELECT COUNT(*) AS n FROM rewards_award_ledger
              WHERE user_id = ? AND trigger_kind = ? AND status = 'settled'`,
        args: [userId, triggerKind],
      });
  return Number(r.rows[0]?.n ?? 0) || 0;
}

// ─── Points writer ───────────────────────────────────────────────────

/**
 * Append a `rewards_events` row + move `users.points_total`, in ONE
 * transaction.
 *
 * This mirrors `recordRewardsEvent` in lib/db.ts. It is re-implemented
 * here for two reasons, both structural rather than stylistic:
 *   • `recordRewardsEvent` types `kind` as `RewardsEventKind`, a closed
 *     union in lib/db.ts (owned by another work stream) with no
 *     `clawback` member, and clawback has to write a feed row too.
 *   • Points must be able to go DOWN without underflowing:
 *     `GREATEST(..., 0)` clamps a reversal to the user's actual balance
 *     so a clawback can't leave a negative `points_total` that the tier
 *     maths and the redeem affordability check would both misread.
 */
export async function writeRewardsEvent(opts: {
  userId: number;
  kind: string;
  points: number;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  const now = Date.now();
  await db().batch(
    [
      {
        sql: `INSERT INTO rewards_events (user_id, kind, points, metadata, created_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          opts.userId,
          opts.kind,
          Math.trunc(opts.points),
          opts.metadata ? JSON.stringify(opts.metadata) : null,
          now,
        ],
      },
      {
        sql: `UPDATE users
              SET points_total = GREATEST(COALESCE(points_total, 0) + ?, 0)
              WHERE id = ?`,
        args: [Math.trunc(opts.points), opts.userId],
      },
    ],
    "write"
  );
}

// ─── Farming flags ───────────────────────────────────────────────────

export type FarmingFlag = {
  userId: number;
  blocked: boolean;
  reason: string;
  actor: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * Is this account barred from earning policy awards (referral payouts,
 * first-send bonus)?
 *
 * A flag is the enforcement half of a clawback: reversing 25,000 points
 * is pointless if the same inviter can re-earn them tomorrow. Money
 * awards (`send_earn` etc.) are deliberately NOT blocked, they're backed
 * by verified on-chain movement and blocking them would punish a real
 * user while an appeal is open.
 */
export async function isFarmingBlocked(userId: number): Promise<boolean> {
  await ensureRewardsIntegritySchema();
  const r = await db().execute({
    sql: `SELECT blocked FROM rewards_farming_flags WHERE user_id = ? LIMIT 1`,
    args: [userId],
  });
  return Number(r.rows[0]?.blocked ?? 0) === 1;
}

export async function setFarmingFlag(opts: {
  userId: number;
  blocked: boolean;
  reason: string;
  actor: string;
}): Promise<void> {
  await ensureRewardsIntegritySchema();
  const now = Date.now();
  await db().execute({
    sql: `INSERT INTO rewards_farming_flags
            (user_id, blocked, reason, actor, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (user_id) DO UPDATE
            SET blocked = EXCLUDED.blocked,
                reason = EXCLUDED.reason,
                actor = EXCLUDED.actor,
                updated_at = EXCLUDED.updated_at`,
    args: [
      opts.userId,
      opts.blocked ? 1 : 0,
      opts.reason.slice(0, 500),
      opts.actor.slice(0, 120),
      now,
      now,
    ],
  });
}

export async function listFarmingFlags(limit = 100): Promise<FarmingFlag[]> {
  await ensureRewardsIntegritySchema();
  const r = await db().execute({
    sql: `SELECT * FROM rewards_farming_flags
          ORDER BY updated_at DESC LIMIT ?`,
    args: [limit],
  });
  return r.rows.map((x) => ({
    userId: Number(x.user_id),
    blocked: Number(x.blocked ?? 0) === 1,
    reason: String(x.reason ?? ""),
    actor: String(x.actor ?? ""),
    createdAt: Number(x.created_at ?? 0) || 0,
    updatedAt: Number(x.updated_at ?? 0) || 0,
  }));
}

// ─── Audit trail ─────────────────────────────────────────────────────

export async function recordIntegrityAudit(opts: {
  userId: number;
  action: string;
  actor: string;
  reason: string;
  pointsBefore?: number | null;
  pointsAfter?: number | null;
  pointsDelta?: number | null;
  rowsAffected?: number | null;
  metadata?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
}): Promise<boolean> {
  await ensureRewardsIntegritySchema();
  const r = await db().execute({
    sql: `INSERT INTO rewards_integrity_audit
            (user_id, action, actor, reason, points_before, points_after,
             points_delta, rows_affected, metadata, idempotency_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING id`,
    args: [
      opts.userId,
      opts.action,
      opts.actor.slice(0, 120),
      opts.reason.slice(0, 500),
      opts.pointsBefore ?? null,
      opts.pointsAfter ?? null,
      opts.pointsDelta ?? null,
      opts.rowsAffected ?? null,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
      opts.idempotencyKey ?? null,
      Date.now(),
    ],
  });
  return r.rows.length > 0;
}

export async function listIntegrityAudit(
  limit = 100
): Promise<Array<Record<string, unknown>>> {
  await ensureRewardsIntegritySchema();
  const r = await db().execute({
    sql: `SELECT * FROM rewards_integrity_audit
          ORDER BY created_at DESC LIMIT ?`,
    args: [limit],
  });
  return r.rows;
}

// ─── Clawback ────────────────────────────────────────────────────────

export type ClawbackScope =
  /** Referral activation + first-send bonuses only. The usual case. */
  | "policy"
  /** Everything the ledger ever paid this account, money awards too. */
  | "all";

export type ClawbackResult = {
  userId: number;
  scope: ClawbackScope;
  /** Points found in the ledger for the scope. */
  pointsFound: number;
  /** Points actually removed from `users.points_total` (clamped at 0). */
  pointsRemoved: number;
  pointsBefore: number;
  pointsAfter: number;
  rowsReversed: number;
  blocked: boolean;
  /** False when an earlier call with the same idempotency key already ran. */
  applied: boolean;
  dryRun: boolean;
};

const POLICY_TRIGGERS: LedgerTrigger[] = [
  "referral_activation",
  "first_send",
  "first_claim",
];

/**
 * Reverse awards for an account found to be farming, with an audit row.
 *
 * Deliberate design choices:
 *   • Only LEDGER-BACKED points are reversible. Points minted before this
 *     table existed (including the 1,008,671,212-pt goal-deposit
 *     incident) have no per-award record, so we do not guess: the
 *     operator gets `pointsFound` and can see the shortfall in the audit
 *     row's metadata.
 *   • `users.points_total` is clamped at 0 by `writeRewardsEvent`, and we
 *     report `pointsRemoved` separately from `pointsFound` so the audit
 *     trail records the discrepancy instead of hiding it.
 *   • The reversal writes a NEGATIVE `rewards_events` row (kind
 *     `clawback`), so the user's own activity feed and /admin/ledger both
 *     show the debit. Silent balance edits are how ledgers rot.
 *   • `dryRun` computes everything and writes nothing. Use it first.
 */
export async function clawbackUser(opts: {
  userId: number;
  scope: ClawbackScope;
  reason: string;
  actor: string;
  /** Also bar the account from future policy awards. Default true. */
  block?: boolean;
  dryRun?: boolean;
  /** Reuse to make a retried clawback a no-op. */
  idempotencyKey?: string;
}): Promise<ClawbackResult> {
  await ensureRewardsIntegritySchema();
  const c = db();
  const dryRun = opts.dryRun === true;
  const block = opts.block !== false;

  const scopeSql =
    opts.scope === "policy"
      ? `AND trigger_kind IN (${POLICY_TRIGGERS.map(() => "?").join(", ")})`
      : "";
  const scopeArgs = opts.scope === "policy" ? POLICY_TRIGGERS : [];

  const found = await c.execute({
    sql: `SELECT id, points FROM rewards_award_ledger
          WHERE user_id = ? AND status = 'settled' ${scopeSql}`,
    args: [opts.userId, ...scopeArgs],
  });
  const ids = found.rows.map((r) => Number(r.id));
  const pointsFound = found.rows.reduce(
    (acc, r) => acc + (Number(r.points ?? 0) || 0),
    0
  );

  const before = await c.execute({
    sql: `SELECT COALESCE(points_total, 0) AS pts FROM users WHERE id = ? LIMIT 1`,
    args: [opts.userId],
  });
  const pointsBefore = Number(before.rows[0]?.pts ?? 0) || 0;
  const pointsRemoved = Math.min(pointsFound, pointsBefore);
  const pointsAfter = pointsBefore - pointsRemoved;

  const result: ClawbackResult = {
    userId: opts.userId,
    scope: opts.scope,
    pointsFound,
    pointsRemoved,
    pointsBefore,
    pointsAfter,
    rowsReversed: ids.length,
    blocked: block,
    applied: false,
    dryRun,
  };
  if (dryRun) return result;

  // Audit FIRST, gated on the idempotency key: whoever wins the insert
  // owns the reversal. A retry with the same key sees `applied: false`
  // and mutates nothing.
  const wonAudit = await recordIntegrityAudit({
    userId: opts.userId,
    action: `clawback:${opts.scope}`,
    actor: opts.actor,
    reason: opts.reason,
    pointsBefore,
    pointsAfter,
    pointsDelta: -pointsRemoved,
    rowsAffected: ids.length,
    metadata: {
      pointsFound,
      pointsRemoved,
      unbackedShortfall: Math.max(pointsFound - pointsBefore, 0),
      ledgerRowIds: ids.slice(0, 200),
      block,
    },
    idempotencyKey: opts.idempotencyKey ?? null,
  });
  if (!wonAudit && opts.idempotencyKey) return result;

  if (ids.length > 0) {
    await c.execute({
      sql: `UPDATE rewards_award_ledger
            SET status = 'clawed_back', clawed_back_at = ?,
                reason = ?
            WHERE id IN (${ids.map(() => "?").join(", ")})`,
      args: [Date.now(), `clawback: ${opts.reason}`.slice(0, 300), ...ids],
    });
  }
  if (pointsRemoved > 0) {
    await writeRewardsEvent({
      userId: opts.userId,
      kind: "clawback",
      points: -pointsRemoved,
      metadata: {
        scope: opts.scope,
        reason: opts.reason,
        actor: opts.actor,
        pointsFound,
        rowsReversed: ids.length,
      },
    });
  }
  if (block) {
    await setFarmingFlag({
      userId: opts.userId,
      blocked: true,
      reason: opts.reason,
      actor: opts.actor,
    });
  }

  result.applied = true;
  return result;
}

/**
 * Mark a `pending` redemption fulfilled.
 *
 * `/api/admin/ledger` is read-only SELECTs, so before this there was NO
 * way to close out a `kind: "pending"` redemption: the row sat at
 * `status = 'pending'` forever and the operator had no record that they'd
 * shipped the perk. Every call lands an audit row.
 *
 * Guarded to `pending → fulfilled` only, so this can never resurrect a
 * refunded/expired redemption or re-fulfil one twice.
 */
export async function fulfilRedemption(opts: {
  redemptionId: number;
  actor: string;
  reason: string;
  /** Operator's expectation of the owner. Mismatch aborts before any write. */
  expectUserId?: number;
}): Promise<{ ok: boolean; reason?: string; userId?: number; sku?: string }> {
  await ensureRewardsIntegritySchema();
  const c = db();
  const cur = await c.execute({
    sql: `SELECT id, user_id, sku, status FROM redemptions WHERE id = ? LIMIT 1`,
    args: [opts.redemptionId],
  });
  const row = cur.rows[0];
  if (!row) return { ok: false, reason: "redemption not found" };
  const ownerId = Number(row.user_id);
  if (opts.expectUserId != null && opts.expectUserId !== ownerId) {
    return {
      ok: false,
      reason: `redemption belongs to user ${ownerId}, not ${opts.expectUserId}`,
      userId: ownerId,
    };
  }
  const status = String(row.status ?? "");
  if (status !== "pending") {
    return { ok: false, reason: `redemption is ${status}, not pending` };
  }
  const upd = await c.execute({
    sql: `UPDATE redemptions SET status = 'fulfilled', fulfilled_at = ?
          WHERE id = ? AND status = 'pending'
          RETURNING id`,
    args: [Date.now(), opts.redemptionId],
  });
  if (upd.rows.length === 0) {
    return { ok: false, reason: "redemption changed status concurrently" };
  }
  await recordIntegrityAudit({
    userId: ownerId,
    action: "fulfil_redemption",
    actor: opts.actor,
    reason: opts.reason,
    metadata: { redemptionId: opts.redemptionId, sku: row.sku },
    idempotencyKey: `fulfil:${opts.redemptionId}`,
  });
  return { ok: true, userId: ownerId, sku: String(row.sku ?? "") };
}
