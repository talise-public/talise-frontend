import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { db, schemaVersionGate } from "./db";
import { encryptAtRest, decryptAtRest } from "./crypto-at-rest";

/**
 * Custodial agent wallets, server-signed money for headless agents.
 *
 * An agent wallet is a CAPPED, REVOCABLE, server-side signer for a user's
 * account. Unlike the normal non-custodial flow (where the client holds the
 * ephemeral key), here the server generates and CUSTODIES the ephemeral key -
 * encrypted at rest, so an agent with no local key can pay via a scoped bearer
 * token. Each wallet has a per-day USD spend cap and can be revoked instantly.
 *
 * FEATURE-GATED OFF by default: `POST /api/agent/pay` 503s unless
 * FEATURE_AGENT_WALLETS === "true". This is a custodial departure from Talise's
 * non-custodial norm, so it stays dark until explicitly enabled and reviewed.
 *
 * Secrets stored (all AES-256-GCM encrypted via crypto-at-rest):
 *   jwt, salt      , the OIDC material the zkLogin proof is minted from
 *   ephemeral_sk_b64, the signing key (the custodial part)
 * Plus the binding (ephemeral_pubkey_b64, max_epoch, randomness) the JWT nonce
 * was bound to, and the derived sui_address for display.
 */

export function agentWalletsEnabled(): boolean {
  return process.env.FEATURE_AGENT_WALLETS?.trim().toLowerCase() === "true";
}

const SCHEMA_VERSION = "2026-07-05.1";
let _ready: Promise<void> | null = null;

async function doEnsureSchema(): Promise<void> {
  const client = db();
  const gate = await schemaVersionGate("agent_wallets_schema_version", SCHEMA_VERSION);
  if (gate.upToDate) return;
  await client.execute(`
    CREATE TABLE IF NOT EXISTS agent_wallets (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT,
      sui_address TEXT NOT NULL,
      jwt TEXT NOT NULL,
      salt TEXT NOT NULL,
      ephemeral_sk_b64 TEXT NOT NULL,
      ephemeral_pubkey_b64 TEXT NOT NULL,
      max_epoch BIGINT NOT NULL,
      randomness TEXT NOT NULL,
      daily_cap_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      spent_today_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      spend_day TEXT,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    )
  `);
  await client.execute(`CREATE INDEX IF NOT EXISTS agent_wallets_user_idx ON agent_wallets(user_id)`);
  await gate.stamp();
}

export async function ensureAgentWalletsSchema(): Promise<void> {
  if (!_ready) {
    _ready = doEnsureSchema().catch((e) => {
      _ready = null;
      throw e;
    });
  }
  return _ready;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function today(): string {
  // UTC day boundary for the rolling daily cap. Passed in from callers that
  // have a clock; here we derive it once at call time.
  return new Date().toISOString().slice(0, 10);
}

export type AgentWalletRow = {
  id: string;
  userId: number;
  name: string | null;
  suiAddress: string;
  jwt: string;
  salt: string;
  ephemeralSkB64: string;
  ephemeralPubKeyB64: string;
  maxEpoch: number;
  randomness: string;
  dailyCapUsd: number;
  spentTodayUsd: number;
  spendDay: string | null;
  revoked: boolean;
};

/** Create a wallet + return the one-time plaintext token (shown once). */
export async function createAgentWallet(opts: {
  userId: number;
  name: string | null;
  suiAddress: string;
  jwt: string;
  salt: string;
  ephemeralSkB64: string;
  ephemeralPubKeyB64: string;
  maxEpoch: number;
  randomness: string;
  dailyCapUsd: number;
}): Promise<{ id: string; token: string }> {
  await ensureAgentWalletsSchema();
  const id = "agw_" + randomBytes(12).toString("hex");
  const token = "tak_" + randomBytes(24).toString("base64url"); // talise agent key
  await db().execute({
    sql: `INSERT INTO agent_wallets
      (id, token_hash, user_id, name, sui_address, jwt, salt, ephemeral_sk_b64,
       ephemeral_pubkey_b64, max_epoch, randomness, daily_cap_usd, spent_today_usd,
       spend_day, revoked, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      id,
      hashToken(token),
      opts.userId,
      opts.name,
      opts.suiAddress,
      encryptAtRest(opts.jwt),
      encryptAtRest(opts.salt),
      encryptAtRest(opts.ephemeralSkB64),
      opts.ephemeralPubKeyB64,
      opts.maxEpoch,
      opts.randomness,
      opts.dailyCapUsd,
      0,
      today(),
      0,
      Date.now(),
    ],
  });
  return { id, token };
}

/** Look up a live (non-revoked) wallet by its bearer token. Decrypts secrets. */
export async function agentWalletByToken(token: string): Promise<AgentWalletRow | null> {
  await ensureAgentWalletsSchema();
  const r = await db().execute({
    sql: `SELECT id, user_id, name, sui_address, jwt, salt, ephemeral_sk_b64,
                 ephemeral_pubkey_b64, max_epoch, randomness, daily_cap_usd,
                 spent_today_usd, spend_day, revoked
          FROM agent_wallets WHERE token_hash = ? LIMIT 1`,
    args: [hashToken(token)],
  });
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  if (Number(row.revoked) === 1) return null;
  return {
    id: String(row.id),
    userId: Number(row.user_id),
    name: (row.name as string) ?? null,
    suiAddress: String(row.sui_address),
    jwt: decryptAtRest(row.jwt as string) ?? "",
    salt: decryptAtRest(row.salt as string) ?? "",
    ephemeralSkB64: decryptAtRest(row.ephemeral_sk_b64 as string) ?? "",
    ephemeralPubKeyB64: String(row.ephemeral_pubkey_b64),
    maxEpoch: Number(row.max_epoch),
    randomness: String(row.randomness),
    dailyCapUsd: Number(row.daily_cap_usd),
    spentTodayUsd: Number(row.spent_today_usd),
    spendDay: (row.spend_day as string) ?? null,
    revoked: Number(row.revoked) === 1,
  };
}

/**
 * Reserve `amountUsd` against the wallet's daily cap. Atomically resets the
 * counter when the UTC day rolls over. Returns false (and reserves nothing)
 * when the spend would exceed the cap. A cap of 0 means "no spending".
 */
export async function reserveAgentSpend(id: string, amountUsd: number): Promise<{ ok: boolean; remaining: number }> {
  await ensureAgentWalletsSchema();
  const day = today();
  // Single UPDATE guarded by the cap; resets spent when the day changed.
  const r = await db().execute({
    sql: `UPDATE agent_wallets
          SET spent_today_usd = CASE WHEN spend_day = ? THEN spent_today_usd ELSE 0 END + ?,
              spend_day = ?
          WHERE id = ?
            AND revoked = 0
            AND (CASE WHEN spend_day = ? THEN spent_today_usd ELSE 0 END) + ? <= daily_cap_usd
          RETURNING daily_cap_usd, spent_today_usd`,
    args: [day, amountUsd, day, id, day, amountUsd],
  });
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return { ok: false, remaining: 0 };
  return { ok: true, remaining: Number(row.daily_cap_usd) - Number(row.spent_today_usd) };
}

/** Release a previously-reserved amount (on a failed send). Never throws. */
export async function releaseAgentSpend(id: string, amountUsd: number): Promise<void> {
  try {
    await db().execute({
      sql: `UPDATE agent_wallets SET spent_today_usd = GREATEST(0, spent_today_usd - ?) WHERE id = ?`,
      args: [amountUsd, id],
    });
  } catch {
    /* best-effort */
  }
}

export type AgentWalletSummary = {
  id: string;
  name: string | null;
  suiAddress: string;
  dailyCapUsd: number;
  spentTodayUsd: number;
  revoked: boolean;
  createdAt: number;
};

export async function listAgentWallets(userId: number): Promise<AgentWalletSummary[]> {
  await ensureAgentWalletsSchema();
  const r = await db().execute({
    sql: `SELECT id, name, sui_address, daily_cap_usd, spent_today_usd, spend_day, revoked, created_at
          FROM agent_wallets WHERE user_id = ? ORDER BY created_at DESC`,
    args: [userId],
  });
  const day = today();
  return (r.rows as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    name: (row.name as string) ?? null,
    suiAddress: String(row.sui_address),
    dailyCapUsd: Number(row.daily_cap_usd),
    // Show 0 spent if the stored day is stale (the cap resets at UTC midnight).
    spentTodayUsd: row.spend_day === day ? Number(row.spent_today_usd) : 0,
    revoked: Number(row.revoked) === 1,
    createdAt: Number(row.created_at),
  }));
}

/** Revoke a wallet the caller owns. Returns true if a row was revoked. */
export async function revokeAgentWallet(userId: number, id: string): Promise<boolean> {
  await ensureAgentWalletsSchema();
  const r = await db().execute({
    sql: `UPDATE agent_wallets SET revoked = 1 WHERE id = ? AND user_id = ? AND revoked = 0`,
    args: [id, userId],
  });
  return (r.rowsAffected ?? 0) > 0;
}
