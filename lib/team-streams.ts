import "server-only";

import { randomBytes } from "node:crypto";
import { db, ensureSchema, schemaVersionGate } from "@/lib/db";
import {
  teamStreamsOnchainEnabled,
  buildTeamStreamCreateSponsored,
  buildReleaseDueTrancheSponsored,
  buildTeamStreamCancelSponsored,
  parseCreatedTeamStreamId,
  verifyStreamTxTouched,
} from "@/lib/team-streams-onchain";

/**
 * Team streaming payments, fund a pot once, then an EQUAL share of each tranche
 * goes to every member of a saved payroll team, on an interval, until the
 * schedule is done.
 *
 * NON-CUSTODIAL + PERMISSIONLESS, on the same model as money rules
 * (`talise_automations::standing_order`). There is NO escrow key, NO scheduler
 * key and NO cron:
 *   • CREATE, the creator signs one Onara-sponsored `team_stream::create` that
 *     moves the WHOLE pot into a `TeamStream<USDSUI>` shared object they own.
 *     Funding and creation are the same transaction, so a stream can only exist
 *     fully funded — there is nothing to "verify was credited" afterwards, and
 *     Talise never holds the money (the old escrow was server-custodied AND
 *     commingled across streams; that risk class is gone).
 *   • RELEASE, `release_due_tranche` is PERMISSIONLESS; the creator's app fires
 *     any due tranche when it's open (Onara-sponsored). The contract pays exactly
 *     the pre-set share to each hardwired member, only once the Clock passes
 *     `next_due_ms`, at most `num_tranches` times. Double-releasing a tranche is
 *     IMPOSSIBLE on chain, which replaces the old atomic DB claim.
 *   • CANCEL, the creator signs `cancel`, which refunds the entire remaining pot
 *     (unreleased tranches + rounding dust) to them.
 *
 * The rows below are a DISPLAY MIRROR of the on-chain schedule plus the list of
 * "which streams are due to fire". The money and the authoritative cursor live on
 * chain, so a stale mirror can only ever cause a no-op abort (ENotDue /
 * EExhausted / ECancelled), never an early, double, or wrong payment.
 *
 * Gated by teamStreamsOnchainEnabled() (TEAM_STREAM_PACKAGE_ID +
 * TEAM_STREAM_REGISTRY_ID). Unset → the feature is off and the routes 503.
 */

export function teamStreamsEnabled(): boolean {
  return teamStreamsOnchainEnabled();
}

// ── Constants ────────────────────────────────────────────────────────────────
/** 0.01 USDsui — the product floor for one person's share of one payout. The
 *  contract only requires a non-zero share; this is the UX guard. */
export const MIN_PER_MEMBER_MICROS = 10_000n;
/** Must not exceed the contract's MAX_MEMBERS (one release pays everyone in one tx). */
const MAX_MEMBERS = 50;
/** Must not exceed the contract's MAX_TRANCHES. */
const MAX_TRANCHES = 365;

// ── Schema ─────────────────────────────────────────────────────────────────
let _schemaReady: Promise<void> | null = null;
const SCHEMA_VERSION = "2026-07-25.1";

export function ensureTeamStreamsSchema(): Promise<void> {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    await ensureSchema();
    const c = db();
    const gate = await schemaVersionGate("team_streams_schema_version", SCHEMA_VERSION);
    if (gate.upToDate) return;

    await c.execute(`
      CREATE TABLE IF NOT EXISTS team_streams (
        id                TEXT PRIMARY KEY,
        sender_user_id    INTEGER NOT NULL,
        sender_address    TEXT NOT NULL,
        team_id           TEXT,
        team_name         TEXT NOT NULL,
        members           TEXT NOT NULL DEFAULT '[]',
        member_count      INTEGER NOT NULL,
        total_micros      BIGINT NOT NULL,
        tranche_micros    BIGINT NOT NULL,
        per_member_micros BIGINT NOT NULL,
        num_tranches      INTEGER NOT NULL,
        tranches_done     INTEGER NOT NULL DEFAULT 0,
        released_micros   BIGINT NOT NULL DEFAULT 0,
        interval_ms       BIGINT NOT NULL,
        start_ms          BIGINT NOT NULL,
        next_tranche_at   BIGINT NOT NULL,
        state             TEXT NOT NULL DEFAULT 'draft',
        funding_digest    TEXT,
        last_tranche_at   BIGINT,
        created_at        BIGINT NOT NULL,
        updated_at        BIGINT NOT NULL
      )
    `);
    // The on-chain `TeamStream<USDSUI>` object this row mirrors. NULL means the
    // row predates the on-chain rail (a legacy escrow stream) or is still a draft.
    await c.execute(`ALTER TABLE team_streams ADD COLUMN IF NOT EXISTS stream_object_id TEXT`);
    await c.execute(`CREATE INDEX IF NOT EXISTS idx_team_streams_user ON team_streams(sender_user_id, created_at DESC)`);
    // "Which of my streams are due to fire" read (listDueTeamStreams).
    await c.execute(`CREATE INDEX IF NOT EXISTS idx_team_streams_due ON team_streams(state, next_tranche_at)`);
    // Append-only release ledger, mirroring confirmed on-chain releases.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS team_stream_tranches (
        id            SERIAL PRIMARY KEY,
        stream_id     TEXT NOT NULL,
        tranche_index INTEGER NOT NULL,
        total_micros  BIGINT NOT NULL,
        digests       TEXT,
        paid_at       BIGINT NOT NULL
      )
    `);
    // The release transaction digest. Unique, so re-posting the same digest can
    // never advance the mirror twice (the chain already can't double-pay).
    await c.execute(`ALTER TABLE team_stream_tranches ADD COLUMN IF NOT EXISTS digest TEXT`);
    await c.execute(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_team_stream_tranche ON team_stream_tranches(stream_id, tranche_index)`);
    await c.execute(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_team_stream_tranche_digest ON team_stream_tranches(digest)`);

    await gate.stamp();
  })().catch((err) => {
    _schemaReady = null;
    throw err;
  });
  return _schemaReady;
}

// ── Types ────────────────────────────────────────────────────────────────────
export interface TeamStreamMember {
  address: string;
  handle: string | null;
}

interface Row {
  id: string;
  sender_user_id: number;
  sender_address: string;
  team_id: string | null;
  team_name: string;
  members: string;
  member_count: number;
  total_micros: number | string;
  tranche_micros: number | string;
  per_member_micros: number | string;
  num_tranches: number;
  tranches_done: number;
  released_micros: number | string;
  interval_ms: number | string;
  start_ms: number | string;
  next_tranche_at: number | string;
  state: string;
  funding_digest: string | null;
  stream_object_id: string | null;
  last_tranche_at: number | string | null;
  created_at: number | string;
  updated_at: number | string;
}

export interface TeamStream {
  id: string;
  teamId: string | null;
  teamName: string;
  members: TeamStreamMember[];
  memberCount: number;
  totalUsd: number;
  /** What leaves the pot per payout — exactly `perMemberUsd × memberCount`. */
  trancheUsd: number;
  perMemberUsd: number;
  numTranches: number;
  tranchesDone: number;
  releasedUsd: number;
  /** Rounding remainder the schedule can't pay out; the creator reclaims it on cancel. */
  dustUsd: number;
  intervalMs: number;
  startMs: number;
  nextTrancheAt: number;
  state: string;
  fundingDigest: string | null;
  /** The on-chain object. `null` ⇒ draft, or a legacy escrow-era stream. */
  streamObjectId: string | null;
  /** True for pre-on-chain rows: never fired by the client trigger. */
  legacy: boolean;
  /** The client fires these on app-open (mirror view; the contract is the gate). */
  dueNow: boolean;
  createdAt: number;
}

const usd = (micros: number | string) => Number(BigInt(micros)) / 1e6;

function project(row: Row, nowMs: number = Date.now()): TeamStream {
  let members: TeamStreamMember[] = [];
  try {
    const parsed = JSON.parse(row.members || "[]");
    if (Array.isArray(parsed)) members = parsed as TeamStreamMember[];
  } catch { /* tolerate */ }
  const total = BigInt(row.total_micros);
  const tranche = BigInt(row.tranche_micros);
  const done = Number(row.tranches_done);
  const num = Number(row.num_tranches);
  const nextAt = Number(row.next_tranche_at);
  const onchain = row.stream_object_id;
  return {
    id: row.id,
    teamId: row.team_id,
    teamName: row.team_name,
    members,
    memberCount: Number(row.member_count),
    totalUsd: usd(row.total_micros),
    trancheUsd: usd(row.tranche_micros),
    perMemberUsd: usd(row.per_member_micros),
    numTranches: num,
    tranchesDone: done,
    releasedUsd: usd(row.released_micros),
    dustUsd: Number(total - tranche * BigInt(num)) / 1e6,
    intervalMs: Number(row.interval_ms),
    startMs: Number(row.start_ms),
    nextTrancheAt: nextAt,
    state: row.state,
    fundingDigest: row.funding_digest,
    streamObjectId: onchain,
    legacy: !onchain && row.state !== "draft",
    dueNow: row.state === "active" && !!onchain && done < num && nextAt <= nowMs,
    createdAt: Number(row.created_at),
  };
}

// ── Create (prepare → sign → record) ─────────────────────────────────────────
export function newTeamStreamId(): string {
  return `tstr_${randomBytes(12).toString("hex")}`;
}

export interface PrepareTeamStreamInput {
  senderUserId: number;
  senderAddress: string;
  teamId: string | null;
  teamName: string;
  /** Already resolved + compliance-screened by the route. */
  members: TeamStreamMember[];
  totalMicros: bigint;
  numTranches: number;
  intervalMs: number;
}

/**
 * Validate the schedule and compute the split EXACTLY as the contract does:
 * `per_member = (total / num_tranches) / member_count` (both divisions truncate),
 * and `tranche = per_member * member_count` is what actually leaves the pot. The
 * remainder (`total - tranche * num_tranches`) is dust the schedule can never pay
 * out; it sits in the pot until the creator cancels (which refunds it).
 */
function validate(input: PrepareTeamStreamInput): { perMemberMicros: bigint; trancheMicros: bigint } {
  const n = input.members.length;
  if (n === 0) throw new Error("This team has no members.");
  if (n > MAX_MEMBERS) throw new Error(`A team stream supports at most ${MAX_MEMBERS} members.`);
  if (!Number.isInteger(input.numTranches) || input.numTranches < 1 || input.numTranches > MAX_TRANCHES) {
    throw new Error(`Number of payouts must be between 1 and ${MAX_TRANCHES}.`);
  }
  if (input.intervalMs < 60_000) throw new Error("Interval must be at least a minute.");
  if (input.totalMicros <= 0n) throw new Error("Enter an amount to stream.");

  const perMemberMicros = input.totalMicros / BigInt(input.numTranches) / BigInt(n);
  if (perMemberMicros < MIN_PER_MEMBER_MICROS) {
    throw new Error("Each person's share per payout must be at least 0.01 USDsui. Fund more or use fewer payouts.");
  }
  return { perMemberMicros, trancheMicros: perMemberMicros * BigInt(n) };
}

/**
 * STEP 1: insert a DRAFT row and return the Onara-sponsored `team_stream::create`
 * bytes the creator signs. Signing that one transaction both funds the pot and
 * creates the on-chain stream — no money moves until they sign, and a draft that
 * is never signed can never pay anyone.
 *
 * The `firstDueMs` handed to the contract is the SAME value mirrored on the row,
 * so the DB's "due" view can never run ahead of the chain's cursor.
 */
export async function prepareCreateTeamStream(input: PrepareTeamStreamInput): Promise<{
  stream: TeamStream;
  bytes: string;
  sponsor: string;
  firstDueMs: number;
}> {
  await ensureTeamStreamsSchema();
  if (!teamStreamsOnchainEnabled()) throw new Error("Team streaming isn't available yet.");
  const { perMemberMicros, trancheMicros } = validate(input);

  const now = Date.now();
  const firstDueMs = now + input.intervalMs;
  const id = newTeamStreamId();

  // Row FIRST, bytes second: a draft with no signature can never pay anyone, but
  // bytes with no row would let a user fund a stream the app can't see.
  await db().execute({
    sql: `INSERT INTO team_streams
            (id, sender_user_id, sender_address, team_id, team_name, members, member_count,
             total_micros, tranche_micros, per_member_micros, num_tranches, tranches_done,
             released_micros, interval_ms, start_ms, next_tranche_at, state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 'draft', ?, ?)`,
    args: [
      id, input.senderUserId, input.senderAddress, input.teamId, input.teamName,
      JSON.stringify(input.members), input.members.length,
      input.totalMicros.toString(), trancheMicros.toString(), perMemberMicros.toString(),
      input.numTranches, input.intervalMs, firstDueMs, firstDueMs, now, now,
    ],
  });

  const { bytes, sponsor } = await buildTeamStreamCreateSponsored({
    sender: input.senderAddress,
    members: input.members.map((m) => m.address),
    numTranches: input.numTranches,
    intervalMs: input.intervalMs,
    firstDueMs,
    totalMicros: input.totalMicros,
  });

  const stream = await getTeamStream(id, input.senderUserId);
  if (!stream) throw new Error("Couldn't draft the stream.");
  return { stream, bytes, sponsor, firstDueMs };
}

/**
 * STEP 2: activate a drafted stream once the creator's `create` transaction has
 * landed. The object id is parsed FROM THE CHAIN (the created `TeamStream`), so
 * a client can't activate a stream that wasn't funded: no object id ⇒ no
 * activation, and the pot is inside that very object.
 *
 * A `create` digest can only ever activate one row (replay guard).
 */
export async function activateTeamStream(id: string, userId: number, fundingDigest: string): Promise<TeamStream | null> {
  await ensureTeamStreamsSchema();
  const stream = await getTeamStream(id, userId);
  if (!stream) return null;
  if (stream.state !== "draft") return stream; // already activated (idempotent)

  const dupe = await db().execute({
    sql: "SELECT id FROM team_streams WHERE funding_digest = ? AND id <> ? LIMIT 1",
    args: [fundingDigest, id],
  });
  if (dupe.rows.length > 0) {
    console.warn(`[team-streams] activation rejected: digest already used digest=${fundingDigest}`);
    return null;
  }

  // The digest is CLIENT-supplied, so the create must have been signed by this
  // row's own creator (fails closed otherwise).
  const expectedSender = await senderAddress(id);
  const objectId = await parseCreatedTeamStreamId(fundingDigest, expectedSender);
  if (!objectId) {
    // Either the tx failed (nothing was funded, nothing to activate) or the
    // fullnode hasn't caught up yet. Ask the client to retry with the same digest,
    // which is safe: activation is idempotent and the pot is already in the object.
    console.warn(`[team-streams] activation deferred: no TeamStream created in digest=${fundingDigest}`);
    throw new Error("Couldn't confirm the on-chain stream yet. Wait a moment and retry.");
  }

  const now = Date.now();
  await db().execute({
    sql: `UPDATE team_streams
             SET state = 'active', funding_digest = ?, stream_object_id = ?, updated_at = ?
           WHERE id = ? AND sender_user_id = ? AND state = 'draft'`,
    args: [fundingDigest, objectId, now, id, userId],
  });
  return getTeamStream(id, userId);
}

// ── Read ─────────────────────────────────────────────────────────────────────
export async function getTeamStream(id: string, userId: number): Promise<TeamStream | null> {
  await ensureTeamStreamsSchema();
  const r = await db().execute({
    sql: "SELECT * FROM team_streams WHERE id = ? AND sender_user_id = ? LIMIT 1",
    args: [id, userId],
  });
  const row = r.rows[0] as unknown as Row | undefined;
  return row ? project(row) : null;
}

export async function listTeamStreams(userId: number): Promise<TeamStream[]> {
  await ensureTeamStreamsSchema();
  const r = await db().execute({
    sql: "SELECT * FROM team_streams WHERE sender_user_id = ? ORDER BY created_at DESC LIMIT 100",
    args: [userId],
  });
  const now = Date.now();
  return (r.rows as unknown as Row[]).map((row) => project(row, now));
}

// ── Client-triggered release (no cron) ───────────────────────────────────────

/**
 * The caller's streams with a tranche DUE to release. The client fetches these
 * when the app opens and fires each via prepare → sign → record.
 *
 * On-chain streams only (`stream_object_id IS NOT NULL`): legacy escrow-era rows
 * have no object to call and are never surfaced here. The on-chain Clock is the
 * real gate, so a stale `next_tranche_at` can only make a trigger no-op with
 * ENotDue — never an early or duplicate payout.
 */
export async function listDueTeamStreams(userId: number, nowMs: number = Date.now()): Promise<TeamStream[]> {
  await ensureTeamStreamsSchema();
  const r = await db().execute({
    sql: `SELECT * FROM team_streams
           WHERE sender_user_id = ? AND state = 'active' AND stream_object_id IS NOT NULL
             AND next_tranche_at <= ? AND tranches_done < num_tranches
           ORDER BY next_tranche_at ASC LIMIT 50`,
    args: [userId, nowMs],
  });
  return (r.rows as unknown as Row[]).map((row) => project(row, nowMs));
}

/**
 * STEP 1 of a release: the Onara-sponsored, PERMISSIONLESS `release_due_tranche`
 * bytes for a stream the caller owns. Built with the CREATOR as sender (their app
 * signs); the contract enforces the schedule, so signing a not-yet-due stream just
 * aborts ENotDue on submit. Returns null when there's no on-chain stream (legacy).
 */
export async function prepareReleaseTeamStream(id: string, userId: number): Promise<{ bytes: string; sponsor: string } | null> {
  const stream = await getTeamStream(id, userId);
  if (!stream || !stream.streamObjectId) return null;
  if (stream.state !== "active") return null;
  const senderAddr = await senderAddress(id);
  if (!senderAddr) return null;
  return buildReleaseDueTrancheSponsored({
    sender: senderAddr,
    streamObjectId: stream.streamObjectId,
    memberCount: stream.memberCount,
  });
}

/**
 * STEP 2 of a release: record a CONFIRMED on-chain release. Verifies the digest
 * succeeded and touched this stream object, then advances the display mirror by
 * one tranche. Idempotent three ways over: the ledger's unique digest index, the
 * guarded `tranches_done` update, and — decisively — the contract, which cannot
 * release the same tranche twice no matter what the mirror says.
 */
export async function recordTeamStreamRelease(id: string, userId: number, digest: string): Promise<TeamStream | null> {
  await ensureTeamStreamsSchema();
  const stream = await getTeamStream(id, userId);
  if (!stream) return null;
  if (!stream.streamObjectId) return stream;

  const ok = await verifyStreamTxTouched({ digest, streamObjectId: stream.streamObjectId });
  if (!ok) {
    console.warn(`[team-streams] release record rejected: digest didn't release ${stream.id} digest=${digest}`);
    return stream;
  }

  const now = Date.now();
  const idx = stream.tranchesDone;
  const trancheMicros = BigInt(Math.round(stream.trancheUsd * 1e6));

  // Ledger FIRST: the unique (stream_id, tranche_index) + unique (digest) indexes
  // make a replayed digest a no-op, so the mirror never double-counts.
  const ledger = await db().execute({
    sql: `INSERT INTO team_stream_tranches (stream_id, tranche_index, total_micros, digest, digests, paid_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING`,
    args: [stream.id, idx, trancheMicros.toString(), digest, JSON.stringify([digest]), now],
  });
  if ((ledger.rowsAffected ?? 0) === 0) return stream; // already recorded

  const willComplete = idx + 1 >= stream.numTranches;
  await db().execute({
    sql: `UPDATE team_streams
             SET tranches_done = ?, released_micros = released_micros + ?,
                 next_tranche_at = next_tranche_at + interval_ms,
                 last_tranche_at = ?, state = ?, updated_at = ?
           WHERE id = ? AND sender_user_id = ? AND state = 'active' AND tranches_done = ?`,
    args: [idx + 1, trancheMicros.toString(), now, willComplete ? "completed" : "active", now, stream.id, userId, idx],
  });
  return getTeamStream(id, userId);
}

// ── Cancel (prepare → sign → record) ─────────────────────────────────────────

/**
 * STEP 1 of a cancel: the creator-signed `cancel` bytes. The PTB refunds the
 * ENTIRE remaining pot (unreleased tranches + the rounding dust) to the creator.
 * Returns null when there's no on-chain stream (a draft or legacy row, which the
 * route then just closes off in the mirror).
 */
export async function prepareCancelTeamStream(id: string, userId: number): Promise<{ bytes: string; sponsor: string } | null> {
  const stream = await getTeamStream(id, userId);
  if (!stream || !stream.streamObjectId) return null;
  if (stream.state === "cancelled") return null;
  const senderAddr = await senderAddress(id);
  if (!senderAddr) return null;
  return buildTeamStreamCancelSponsored({ sender: senderAddr, streamObjectId: stream.streamObjectId });
}

/**
 * STEP 2 of a cancel: mark the mirror cancelled once the on-chain `cancel` has
 * landed. If the client never gets here the chain is still authoritative — a later
 * release trigger simply aborts ECancelled and the client skips it.
 */
export async function recordTeamStreamCancelled(id: string, userId: number, digest: string | null): Promise<TeamStream | null> {
  await ensureTeamStreamsSchema();
  const stream = await getTeamStream(id, userId);
  if (!stream) return null;
  if (stream.streamObjectId && digest) {
    const ok = await verifyStreamTxTouched({ digest, streamObjectId: stream.streamObjectId });
    if (!ok) {
      console.warn(`[team-streams] cancel record rejected: digest didn't touch ${stream.id} digest=${digest}`);
      return stream;
    }
  }
  await db().execute({
    sql: `UPDATE team_streams SET state = 'cancelled', updated_at = ?
           WHERE id = ? AND sender_user_id = ? AND state IN ('draft','active','completed')`,
    args: [Date.now(), id, userId],
  });
  return getTeamStream(id, userId);
}

async function senderAddress(id: string): Promise<string> {
  const r = await db().execute({ sql: "SELECT sender_address FROM team_streams WHERE id = ? LIMIT 1", args: [id] });
  return String((r.rows[0] as { sender_address?: string } | undefined)?.sender_address ?? "");
}
