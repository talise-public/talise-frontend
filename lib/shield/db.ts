import "server-only";

import { db, ensureSchema, schemaVersionGate } from "@/lib/db";

/**
 * Talise shielded-pool, Postgres schema (Workstream C).
 *
 * Self-bootstrapping feature schema, mirroring the cheques / streams
 * precedent (lib/streams.ts ensureStreamsSchema): a once-per-process promise
 * guarded by `schemaVersionGate('shield', …)` so the DDL replay (~8
 * round-trips) is skipped on every warm cold-start while the version marker
 * matches. Bump SHIELD_SCHEMA_VERSION whenever ANY DDL below changes.
 *
 * All tables are inert until the indexer writes to them, which only happens
 * when `shieldConfigured()` is true. They are created eagerly the first time
 * any `/api/shield/*` route runs so a fresh deployment has somewhere to land
 * the first batch of events.
 *
 * Tables
 *   shield_commitments   one row per appended Merkle leaf (NewCommitment).
 *                        PK (coin_type, leaf_index); event_seq is the global
 *                        ordering key + idempotency guard (UNIQUE).
 *   shield_nullifiers    one row per spent input (NullifierSpent).
 *   shield_pools         per-CoinType pool address registry (NewPool).
 *   shield_index_cursor  per-pipeline `suix_queryEvents` cursor.
 *   shield_merkle_cache  per-CoinType cached incremental-tree state + root.
 *   shield_identity      per-user shield pubkey + enc pubkey directory; the
 *                        off-chain lookup rail for hidden-amount transfers.
 */

// Bump on ANY DDL edit below.
const SHIELD_SCHEMA_VERSION = "2026-06-21.1";

let _schemaReadyP: Promise<void> | null = null;

export function ensureShieldSchema(): Promise<void> {
  if (_schemaReadyP) return _schemaReadyP;
  _schemaReadyP = (async () => {
    await ensureSchema();
    const c = db();

    const gate = await schemaVersionGate("shield_schema_version", SHIELD_SCHEMA_VERSION);
    if (gate.upToDate) return;

    // ── shield_commitments ───────────────────────────────────────────
    // One row per appended Merkle leaf. `leaf_index` is the on-chain
    // `NewCommitment.index` (two emitted per `transact`). `commitment` /
    // `encrypted_output` are stored as TEXT: the commitment is a u256
    // decimal string (out of JS-number range), the ciphertext a 0x-hex
    // blob the recipient trial-decrypts. `event_seq` is the global event
    // ordering key (UNIQUE), the indexer's idempotency guard so a replayed
    // poll page is a no-op via ON CONFLICT.
    await c.execute(
      `CREATE TABLE IF NOT EXISTS shield_commitments (
        coin_type        TEXT NOT NULL,
        leaf_index       BIGINT NOT NULL,
        commitment       TEXT NOT NULL,
        encrypted_output TEXT,
        digest           TEXT,
        sender           TEXT,
        checkpoint       BIGINT,
        event_seq        TEXT NOT NULL,
        created_at       BIGINT NOT NULL,
        PRIMARY KEY (coin_type, leaf_index)
      )`
    );
    // BUGFIX: a UNIQUE index on event_seq ALONE was wrong, event_seq is the
    // PER-TX event index ("0","1",…), NOT globally unique, so every commitment
    // after the first tx collided and was silently dropped (only 2 leaves ever
    // persisted while 20 sat on-chain). Idempotency is the PK (coin_type,
    // leaf_index), which IS unique per leaf. Drop the broken index.
    await c.execute(`DROP INDEX IF EXISTS uniq_shield_commitments_event_seq`);
    // Hot scan: rebuild / extend the tree in leaf order for one coin type.
    await c.execute(
      `CREATE INDEX IF NOT EXISTS idx_shield_commitments_scan
         ON shield_commitments (coin_type, leaf_index)`
    );

    // ── shield_nullifiers ────────────────────────────────────────────
    // One row per spent input nullifier. `nullifier` is a u256 decimal
    // string. PK (coin_type, nullifier) makes the existence check a single
    // indexed lookup and makes re-ingest idempotent.
    await c.execute(
      `CREATE TABLE IF NOT EXISTS shield_nullifiers (
        coin_type  TEXT NOT NULL,
        nullifier  TEXT NOT NULL,
        digest     TEXT,
        checkpoint BIGINT,
        event_seq  TEXT,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (coin_type, nullifier)
      )`
    );
    // Same bug as commitments, event_seq is not globally unique. Idempotency
    // is the PK (coin_type, nullifier). Drop the broken index.
    await c.execute(`DROP INDEX IF EXISTS uniq_shield_nullifiers_event_seq`);

    // ── shield_pools ─────────────────────────────────────────────────
    // Per-CoinType pool address registry (from NewPool). One pool per
    // coin type; `pool_address` is the on-chain `ShieldedPool<T>` object.
    await c.execute(
      `CREATE TABLE IF NOT EXISTS shield_pools (
        coin_type    TEXT PRIMARY KEY,
        pool_address TEXT NOT NULL,
        digest       TEXT,
        checkpoint   BIGINT,
        created_at   BIGINT NOT NULL
      )`
    );

    // ── shield_index_cursor ──────────────────────────────────────────
    // Per-pipeline `suix_queryEvents` cursor. `pipeline` is one of
    // 'commitments' | 'nullifiers' | 'pools'. The cursor is the opaque
    // {txDigest, eventSeq} pair Sui hands back; we store both halves plus
    // the checkpoint for the consistency check. Advanced atomically in the
    // same batch as the event writes so a crash never skips events.
    await c.execute(
      `CREATE TABLE IF NOT EXISTS shield_index_cursor (
        pipeline   TEXT PRIMARY KEY,
        tx_digest  TEXT,
        event_seq  TEXT,
        checkpoint BIGINT,
        updated_at BIGINT NOT NULL
      )`
    );

    // ── shield_merkle_cache ──────────────────────────────────────────
    // Per-CoinType cached incremental-tree state. `tree_state` is the JSONB
    // frontier (per-level left-sibling hashes) the merkle module folds new
    // leaves into; `last_index` is the highest leaf folded in; `root` is the
    // current root (u256 decimal string). Lets the merkle-path service serve
    // a path without re-folding every leaf from genesis on a cold instance.
    await c.execute(
      `CREATE TABLE IF NOT EXISTS shield_merkle_cache (
        coin_type  TEXT PRIMARY KEY,
        tree_state JSONB NOT NULL,
        last_index BIGINT NOT NULL,
        root       TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      )`
    );

    // ── shield_identity ──────────────────────────────────────────────
    // Per-user shield-identity directory, the off-chain lookup rail for
    // hidden-amount transfers. A sender resolves a recipient by their public
    // `sui_address` to get the recipient's shield SPENDING pubkey + enc pubkey
    // (both PUBLIC keys, never on-chain). PK (user_id) keeps re-publish an
    // idempotent UPSERT; the sui_address index serves the recipient lookup.
    //   pubkey   , Poseidon1(spendingKey) as a u256 decimal string.
    //   enc_pubkey, 0x04-prefixed uncompressed P-256 point (0x04 + 128 hex).
    await c.execute(
      `CREATE TABLE IF NOT EXISTS shield_identity (
        user_id     TEXT PRIMARY KEY,
        sui_address TEXT NOT NULL,
        pubkey      TEXT NOT NULL,
        enc_pubkey  TEXT NOT NULL,
        created_at  BIGINT,
        updated_at  BIGINT
      )`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS idx_shield_identity_sui_address
         ON shield_identity (sui_address)`
    );

    await gate.stamp();
  })().catch((err) => {
    _schemaReadyP = null;
    throw err;
  });
  return _schemaReadyP;
}

// ── Row types ─────────────────────────────────────────────────────────

export interface ShieldCommitmentRow {
  coin_type: string;
  leaf_index: number;
  commitment: string;
  encrypted_output: string | null;
  digest: string | null;
  sender: string | null;
  checkpoint: number | null;
  event_seq: string;
  created_at: number;
}

export interface ShieldCursorRow {
  pipeline: string;
  tx_digest: string | null;
  event_seq: string | null;
  checkpoint: number | null;
  updated_at: number;
}

export interface ShieldMerkleCacheRow {
  coin_type: string;
  tree_state: unknown;
  last_index: number;
  root: string;
  updated_at: number;
}

export type ShieldPipeline = "commitments" | "nullifiers" | "pools";

// ── Cursor helpers ──────────────────────────────────────────────────────

/** Read the stored cursor for a pipeline (null when never run). */
export async function getShieldCursor(
  pipeline: ShieldPipeline
): Promise<{ txDigest: string; eventSeq: string } | null> {
  await ensureShieldSchema();
  const r = await db().execute({
    sql: `SELECT tx_digest, event_seq FROM shield_index_cursor WHERE pipeline = ? LIMIT 1`,
    args: [pipeline],
  });
  const row = r.rows[0] as { tx_digest?: string; event_seq?: string } | undefined;
  if (!row?.tx_digest || !row?.event_seq) return null;
  return { txDigest: row.tx_digest, eventSeq: row.event_seq };
}

/** Highest contiguous leaf index already stored for a coin type, or -1. */
export async function maxLeafIndex(coinType: string): Promise<number> {
  await ensureShieldSchema();
  const r = await db().execute({
    sql: `SELECT MAX(leaf_index) AS m FROM shield_commitments WHERE coin_type = ?`,
    args: [coinType],
  });
  const m = (r.rows[0] as { m?: number | null } | undefined)?.m;
  return typeof m === "number" ? m : -1;
}
