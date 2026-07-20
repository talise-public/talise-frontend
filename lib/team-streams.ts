import "server-only";

import { randomBytes } from "node:crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { db, ensureSchema, schemaVersionGate } from "@/lib/db";
import { sui } from "@/lib/sui";
import { USDSUI_TYPE } from "@/lib/usdsui";
import { getChainIdentifier, getCurrentEpoch } from "@/lib/sui-epoch";

/**
 * Team streaming payments, fund a pot once, then a gasless scheduler releases an
 * EQUAL share of each tranche to every member of a saved payroll team, on an
 * interval, until the pot is exhausted.
 *
 * Reuses the proven server-custodied escrow model (mirrors lib/cheques.ts):
 *   • The creator funds the FULL amount into a Talise-controlled escrow address
 *     over the normal gasless send rail (a `0x2::balance::send_funds<USDSUI>`
 *     that credits the escrow's Address Balance accumulator).
 *   • A Vercel cron (`/api/cron/process-team-streams`) releases each due tranche
 *     by signing escrow→member `send_funds` transfers with the server escrow key
 *     (`PAYROLL_STREAM_ESCROW_SK`). Gasless: zero gas price/budget, no gas payment,
 *     epoch-bounded expiration, identical to the cheque escrow release recipe.
 *
 * The escrow holds money commingled across streams; the DB is the ledger that
 * bounds each stream to exactly what it funded. Gated by PAYROLL_STREAM_ESCROW_SK
 * (unset → feature off, nothing in prod changes).
 */

// ── Escrow key (server-custodied) ───────────────────────────────────────────
let _escrow: Ed25519Keypair | null = null;

export function teamStreamsEnabled(): boolean {
  return !!process.env.PAYROLL_STREAM_ESCROW_SK;
}

function escrowKeypair(): Ed25519Keypair {
  if (_escrow) return _escrow;
  const k = process.env.PAYROLL_STREAM_ESCROW_SK;
  if (!k) throw new Error("PAYROLL_STREAM_ESCROW_SK missing, the team-stream escrow key");
  _escrow = Ed25519Keypair.fromSecretKey(k);
  return _escrow;
}

export function teamStreamEscrowAddress(): string {
  return escrowKeypair().getPublicKey().toSuiAddress();
}

// ── Constants ────────────────────────────────────────────────────────────────
export const MIN_PER_MEMBER_MICROS = 10_000n; // 0.01 USDsui, the gasless minimum per leg
const MAX_MEMBERS = 50;
const MAX_TRANCHES = 365;

// ── Schema ─────────────────────────────────────────────────────────────────
let _schemaReady: Promise<void> | null = null;
const SCHEMA_VERSION = "2026-06-26.1";

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
    await c.execute(`CREATE INDEX IF NOT EXISTS idx_team_streams_user ON team_streams(sender_user_id, created_at DESC)`);
    // Cron read: active streams ordered by their next due time.
    await c.execute(`CREATE INDEX IF NOT EXISTS idx_team_streams_due ON team_streams(state, next_tranche_at)`);
    // Append-only release ledger; the unique index is the double-pay guard.
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
    await c.execute(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_team_stream_tranche ON team_stream_tranches(stream_id, tranche_index)`);

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
  trancheUsd: number;
  perMemberUsd: number;
  numTranches: number;
  tranchesDone: number;
  releasedUsd: number;
  intervalMs: number;
  startMs: number;
  nextTrancheAt: number;
  state: string;
  fundingDigest: string | null;
  createdAt: number;
}

const usd = (micros: number | string) => Number(BigInt(micros)) / 1e6;

function project(row: Row): TeamStream {
  let members: TeamStreamMember[] = [];
  try {
    const parsed = JSON.parse(row.members || "[]");
    if (Array.isArray(parsed)) members = parsed as TeamStreamMember[];
  } catch { /* tolerate */ }
  return {
    id: row.id,
    teamId: row.team_id,
    teamName: row.team_name,
    members,
    memberCount: Number(row.member_count),
    totalUsd: usd(row.total_micros),
    trancheUsd: usd(row.tranche_micros),
    perMemberUsd: usd(row.per_member_micros),
    numTranches: Number(row.num_tranches),
    tranchesDone: Number(row.tranches_done),
    releasedUsd: usd(row.released_micros),
    intervalMs: Number(row.interval_ms),
    startMs: Number(row.start_ms),
    nextTrancheAt: Number(row.next_tranche_at),
    state: row.state,
    fundingDigest: row.funding_digest,
    createdAt: Number(row.created_at),
  };
}

// ── Create / record / read / cancel ──────────────────────────────────────────
export function newTeamStreamId(): string {
  return `tstr_${randomBytes(12).toString("hex")}`;
}

/**
 * Insert a DRAFT team stream. `members` are already-resolved addresses (the route
 * resolves + screens them). Validates the per-member tranche clears the gasless
 * minimum. The pot is split equally: each tranche pays `total/numTranches`, and
 * that tranche is split equally across members.
 */
export async function createDraftTeamStream(input: {
  senderUserId: number;
  senderAddress: string;
  teamId: string | null;
  teamName: string;
  members: TeamStreamMember[];
  totalMicros: bigint;
  numTranches: number;
  intervalMs: number;
}): Promise<TeamStream> {
  await ensureTeamStreamsSchema();
  const n = input.members.length;
  if (n === 0) throw new Error("This team has no members.");
  if (n > MAX_MEMBERS) throw new Error(`A team stream supports at most ${MAX_MEMBERS} members.`);
  if (!Number.isInteger(input.numTranches) || input.numTranches < 1 || input.numTranches > MAX_TRANCHES) {
    throw new Error(`Number of payouts must be between 1 and ${MAX_TRANCHES}.`);
  }
  if (input.intervalMs < 60_000) throw new Error("Interval must be at least a minute.");

  const trancheMicros = input.totalMicros / BigInt(input.numTranches);
  const perMemberMicros = trancheMicros / BigInt(n);
  if (perMemberMicros < MIN_PER_MEMBER_MICROS) {
    throw new Error("Each person's share per payout must be at least 0.01 USDsui. Fund more or use fewer payouts.");
  }

  const now = Date.now();
  const id = newTeamStreamId();
  // First tranche is due one interval after funding (set on record()).
  const startMs = now + input.intervalMs;
  await db().execute({
    sql: `INSERT INTO team_streams
            (id, sender_user_id, sender_address, team_id, team_name, members, member_count,
             total_micros, tranche_micros, per_member_micros, num_tranches, tranches_done,
             released_micros, interval_ms, start_ms, next_tranche_at, state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 'draft', ?, ?)`,
    args: [
      id, input.senderUserId, input.senderAddress, input.teamId, input.teamName,
      JSON.stringify(input.members), n,
      input.totalMicros.toString(), trancheMicros.toString(), perMemberMicros.toString(),
      input.numTranches, input.intervalMs, startMs, startMs, now, now,
    ],
  });
  return getTeamStream(id, input.senderUserId) as Promise<TeamStream>;
}

/** Activate a draft once its funding send has landed. */
export async function activateTeamStream(id: string, userId: number, fundingDigest: string): Promise<TeamStream | null> {
  await ensureTeamStreamsSchema();
  const now = Date.now();
  const stream = await getTeamStream(id, userId);
  if (!stream) return null;
  const nextAt = now + stream.intervalMs;
  await db().execute({
    sql: `UPDATE team_streams
             SET state = 'active', funding_digest = ?, start_ms = ?, next_tranche_at = ?, updated_at = ?
           WHERE id = ? AND sender_user_id = ? AND state = 'draft'`,
    args: [fundingDigest, nextAt, nextAt, now, id, userId],
  });
  return getTeamStream(id, userId);
}

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
  return (r.rows as unknown as Row[]).map(project);
}

/**
 * Cancel a stream and refund the unspent remainder to the sender (gasless escrow
 * send). Idempotent: only an active/paused stream cancels.
 */
export async function cancelTeamStream(id: string, userId: number): Promise<TeamStream | null> {
  await ensureTeamStreamsSchema();
  const stream = await getTeamStream(id, userId);
  if (!stream) return null;
  if (stream.state !== "active" && stream.state !== "paused") return stream;

  // Claim the cancel atomically so the cron can't release concurrently.
  const claim = await db().execute({
    sql: `UPDATE team_streams SET state = 'cancelling', updated_at = ?
           WHERE id = ? AND sender_user_id = ? AND state IN ('active','paused')`,
    args: [Date.now(), id, userId],
  });
  if ((claim.rowsAffected ?? 0) === 0) return getTeamStream(id, userId);

  const remainingMicros = BigInt(Math.round((stream.totalUsd - stream.releasedUsd) * 1e6));
  if (remainingMicros >= MIN_PER_MEMBER_MICROS) {
    try {
      const refundTo = await senderAddress(id);
      await escrowSendFunds(stream.id, "refund", [{ address: refundTo, micros: remainingMicros }]);
    } catch (err) {
      console.warn(`[team-streams] refund on cancel failed for ${id}: ${(err as Error).message}`);
      // Leave state 'cancelling' → a later manual sweep can retry; do not crash cancel.
    }
  }
  await db().execute({
    sql: `UPDATE team_streams SET state = 'cancelled', updated_at = ? WHERE id = ?`,
    args: [Date.now(), id],
  });
  return getTeamStream(id, userId);
}

async function senderAddress(id: string): Promise<string> {
  const r = await db().execute({ sql: "SELECT sender_address FROM team_streams WHERE id = ? LIMIT 1", args: [id] });
  return String((r.rows[0] as { sender_address?: string } | undefined)?.sender_address ?? "");
}

// ── Release engine (cron) ─────────────────────────────────────────────────────

/**
 * Release every due tranche across all active streams. Each tranche is claimed
 * atomically (bump `tranches_done` via a guarded UPDATE) before any payout, so a
 * concurrent/duplicate cron can never double-pay. Returns a summary for the cron.
 */
export async function releaseDueTeamStreams(nowMs: number = Date.now()): Promise<{ processed: number; released: number; errors: number }> {
  await ensureTeamStreamsSchema();
  const due = await db().execute({
    sql: `SELECT * FROM team_streams
           WHERE state = 'active' AND next_tranche_at <= ? AND tranches_done < num_tranches
           ORDER BY next_tranche_at ASC LIMIT 50`,
    args: [nowMs],
  });
  let processed = 0, released = 0, errors = 0;
  for (const raw of due.rows as unknown as Row[]) {
    processed++;
    try {
      if (await releaseOneTranche(project(raw))) released++;
    } catch (err) {
      errors++;
      console.warn(`[team-streams] release failed for ${raw.id}: ${(err as Error).message}`);
    }
  }
  return { processed, released, errors };
}

async function releaseOneTranche(stream: TeamStream): Promise<boolean> {
  const idx = stream.tranchesDone;
  // CLAIM the tranche: only the worker that flips tranches_done from idx→idx+1 proceeds.
  const now = Date.now();
  const nextAt = stream.nextTrancheAt + stream.intervalMs;
  const willComplete = idx + 1 >= stream.numTranches;
  const trancheMicros = BigInt(Math.round(stream.trancheUsd * 1e6));
  const claim = await db().execute({
    sql: `UPDATE team_streams
             SET tranches_done = ?, released_micros = released_micros + ?,
                 next_tranche_at = ?, last_tranche_at = ?, state = ?, updated_at = ?
           WHERE id = ? AND state = 'active' AND tranches_done = ?`,
    args: [
      idx + 1, trancheMicros.toString(), nextAt, now,
      willComplete ? "completed" : "active", now, stream.id, idx,
    ],
  });
  if ((claim.rowsAffected ?? 0) === 0) return false; // someone else claimed it

  // Pay each member their equal share (gasless escrow send_funds).
  const perMemberMicros = BigInt(Math.round(stream.perMemberUsd * 1e6));
  const legs = stream.members.map((m) => ({ address: m.address, micros: perMemberMicros }));
  const digests = await escrowSendFunds(stream.id, `tranche:${idx}`, legs);

  // Ledger the tranche (idempotent on the unique index).
  await db().execute({
    sql: `INSERT INTO team_stream_tranches (stream_id, tranche_index, total_micros, digests, paid_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (stream_id, tranche_index) DO NOTHING`,
    args: [stream.id, idx, trancheMicros.toString(), JSON.stringify(digests), now],
  });
  return true;
}

/**
 * Sign + submit one gasless escrow `send_funds` per leg with the server escrow key.
 * Mirrors lib/cheques.ts::escrowTransfer exactly (zero gas, epoch-bounded expiration,
 * empty gas payment). One tx per leg, the gasless rail permits a single send_funds.
 */
async function escrowSendFunds(
  streamId: string,
  ref: string,
  legs: Array<{ address: string; micros: bigint }>,
): Promise<string[]> {
  const kp = escrowKeypair();
  const sender = kp.getPublicKey().toSuiAddress();
  const client = sui();
  const [chainId, currentEpoch] = await Promise.all([getChainIdentifier(), getCurrentEpoch()]);
  const epoch = BigInt(currentEpoch);
  const digests: string[] = [];

  for (const leg of legs) {
    if (leg.micros < MIN_PER_MEMBER_MICROS) continue;
    const tx = new Transaction();
    tx.setSender(sender);
    tx.moveCall({
      target: "0x2::balance::send_funds",
      typeArguments: [USDSUI_TYPE],
      arguments: [tx.balance({ type: USDSUI_TYPE, balance: leg.micros }), tx.pure.address(leg.address)],
    });
    tx.setGasPrice(0n);
    tx.setGasBudget(0n);
    tx.setExpiration({
      ValidDuring: {
        minEpoch: String(epoch),
        maxEpoch: String(epoch + 1n),
        minTimestamp: null,
        maxTimestamp: null,
        chain: chainId,
        nonce: randomBytes(4).readUInt32BE(0),
      },
    });
    tx.setGasPayment([]);
    const bytes = await tx.build({ client: client as never });
    const { signature } = await kp.signTransaction(bytes);
    const result = (await client.executeTransaction({
      transaction: fromBase64(Buffer.from(bytes).toString("base64")),
      signatures: [signature],
    })) as Record<string, unknown>;
    const inner =
      (result.Transaction as { digest?: string } | undefined) ??
      (result.FailedTransaction as { digest?: string } | undefined);
    const digest = (result.digest as string | undefined) ?? inner?.digest;
    if (!digest || (result.$kind as string | undefined) === "FailedTransaction") {
      throw new Error(`escrow release failed (${ref}) → ${leg.address}`);
    }
    digests.push(digest);
  }
  return digests;
}
