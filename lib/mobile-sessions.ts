import { randomBytes, createHash } from "node:crypto";
import { sign, verify } from "./auth";
import { db, ensureSchema, schemaVersionGate } from "./db";
import { encryptAtRest, decryptAtRest } from "@/lib/crypto-at-rest";

/**
 * Bearer tokens for the iOS app. The Talise web flow continues to use
 * httpOnly cookies; mobile bearers exist alongside them and carry the
 * same user id payload.
 *
 * Storage: a `mobile_sessions` table keyed by SHA-256(token). We never
 * store the token plaintext on the server. Tokens have a long, SLIDING TTL
 * (60 days, pushed forward on every authed request) so an active user stays
 * signed in and the session only ends when it genuinely lapses.
 *
 * Each session also stores the Google id_token (JWT) and Shinami salt
 * that the user signed in with. These two are what the zkLogin signer
 * needs to assemble a SerializedSignature on every sponsor-execute call
 * — the web flow stores them in a signing cookie; mobile stores them
 * here. JWT outlives a single bearer (Google JWTs are 1h, our bearers
 * are 24h) but Shinami's prover still accepts an expired JWT as long
 * as the proof was minted while it was fresh — so for signing purposes
 * we keep the JWT until the bearer rotates.
 */
// Long-lived, SLIDING session. A consumer wallet shouldn't log people out on
// a fixed timer — the app keeps the user signed in and only the session's own
// genuine expiry ends it. 60-day window, slid forward on every authed request
// (see verifyMobileBearer), so an active user effectively never expires; only
// a session unused for 60 straight days lapses.
const MOBILE_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 60; // 60 days
// Throttle the sliding UPDATE: only extend once the session has aged ≥1 day
// since its expiry was last bumped, so we don't write on every request.
const MOBILE_SESSION_SLIDE_THRESHOLD_MS = 1000 * 60 * 60 * 24; // 1 day

// Gate the schema DDL to ONCE per process. verifyMobileBearer() (and
// issueMobileBearer) used to re-run ~7 CREATE/INDEX/ALTER statements on
// every authed request — the ALTERs throw-and-swallow every time once the
// columns exist, wasting a DB round-trip per request on the hot auth path.
// The memoized promise makes it a no-op after the first call on an instance,
// mirroring ensureSchema's own `_schemaReadyP` discipline. The `?? undefined`
// reset on failure lets a transient error retry on the next call.
let _mobileSchemaReadyP: Promise<void> | null = null;

// Bump whenever ANY DDL below changes — the one-SELECT version gate skips the
// replay (~7 round-trips, several on purpose-failing ALTERs) on every cold
// start. This schema is on the AUTH path of every API request, so the skip
// directly speeds up the first authenticated call of each cold instance.
const MOBILE_SESSIONS_SCHEMA_VERSION = "2026-06-10.1";

async function doEnsureMobileSessionsSchema(): Promise<void> {
  await ensureSchema();
  const client = db();

  const gate = await schemaVersionGate(
    "mobile_sessions_schema_version",
    MOBILE_SESSIONS_SCHEMA_VERSION
  );
  if (gate.upToDate) return;

  await client.execute(`
    CREATE TABLE IF NOT EXISTS mobile_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      device_id TEXT,
      app_attest_key_id TEXT,
      jwt TEXT,
      salt TEXT,
      ephemeral_pubkey_b64 TEXT,
      max_epoch BIGINT,
      randomness TEXT,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    )
  `);
  await client.execute(
    `CREATE INDEX IF NOT EXISTS mobile_sessions_user_idx ON mobile_sessions(user_id)`
  );
  // Defensive ALTERs for installs that pre-date later columns.
  // Idempotent: errors when columns already exist are swallowed.
  for (const sql of [
    `ALTER TABLE mobile_sessions ADD COLUMN jwt TEXT`,
    `ALTER TABLE mobile_sessions ADD COLUMN salt TEXT`,
    `ALTER TABLE mobile_sessions ADD COLUMN ephemeral_pubkey_b64 TEXT`,
    `ALTER TABLE mobile_sessions ADD COLUMN max_epoch INTEGER`,
    `ALTER TABLE mobile_sessions ADD COLUMN randomness TEXT`,
  ]) {
    try {
      await client.execute(sql);
    } catch {}
  }

  await gate.stamp();
}

export async function ensureMobileSessionsSchema(): Promise<void> {
  if (!_mobileSchemaReadyP) {
    _mobileSchemaReadyP = doEnsureMobileSessionsSchema().catch((e) => {
      // Reset so the next call retries rather than caching a failure.
      _mobileSchemaReadyP = null;
      throw e;
    });
  }
  return _mobileSchemaReadyP;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueMobileBearer(
  userId: number,
  opts: {
    deviceId?: string;
    jwt?: string;
    salt?: string;
    /// The ephemeral public key whose nonce-hash is baked into jwt.nonce.
    /// Persisted so sponsor-execute uses the SAME pubkey the prover
    /// expects — mismatching it produces -32602 Invalid params.
    ephemeralPubKeyB64?: string;
    maxEpoch?: number;
    randomness?: string;
  } = {}
): Promise<string> {
  await ensureMobileSessionsSchema();
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  await db().execute({
    sql: `INSERT INTO mobile_sessions
            (token_hash, user_id, device_id, jwt, salt,
             ephemeral_pubkey_b64, max_epoch, randomness,
             created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      hash(token),
      userId,
      opts.deviceId ?? null,
      encryptAtRest(opts.jwt ?? null),
      encryptAtRest(opts.salt ?? null),
      opts.ephemeralPubKeyB64 ?? null,
      opts.maxEpoch ?? null,
      opts.randomness ?? null,
      now,
      now + MOBILE_SESSION_TTL_MS,
    ],
  });
  // Return token signed so we can fast-validate at the edge before hitting DB.
  return sign(token);
}

export async function verifyMobileBearer(signedToken: string): Promise<number | null> {
  const token = verify(signedToken);
  if (!token) return null;
  await ensureMobileSessionsSchema();
  const row = await db().execute({
    sql: `SELECT user_id, expires_at, revoked FROM mobile_sessions WHERE token_hash = ?`,
    args: [hash(token)],
  });
  const r = row.rows[0] as unknown as { user_id: number; expires_at: number; revoked: number } | undefined;
  if (!r) return null;
  if (r.revoked) return null;
  const now = Date.now();
  if (r.expires_at < now) return null;

  // Sliding refresh: this token was just used, so push its expiry forward to
  // now + TTL. Throttled to at most once/day per session (only when the new
  // expiry would advance by ≥1 day) to avoid a DB write on every request.
  // Fire-and-forget — never block or fail the auth check on the slide.
  const freshExpiry = now + MOBILE_SESSION_TTL_MS;
  if (freshExpiry - r.expires_at >= MOBILE_SESSION_SLIDE_THRESHOLD_MS) {
    void db()
      .execute({
        sql: `UPDATE mobile_sessions SET expires_at = ? WHERE token_hash = ? AND revoked = 0`,
        args: [freshExpiry, hash(token)],
      })
      .catch(() => {});
  }
  return r.user_id;
}

export async function revokeAllMobileSessions(userId: number) {
  await ensureMobileSessionsSchema();
  await db().execute({
    sql: `UPDATE mobile_sessions SET revoked = 1 WHERE user_id = ?`,
    args: [userId],
  });
}

/**
 * Look up the (jwt, salt) pair stored on the most recent live bearer for
 * a given user. Used by the zkLogin signer to assemble SerializedSignature
 * on mobile-originated requests (replacing the web flow's signing cookie).
 *
 * Returns null if no live mobile session exists, or if the stored row
 * doesn't carry signing material (legacy rows before this column existed).
 */
export async function mobileSigningContext(
  userId: number
): Promise<{
  jwt: string;
  salt: string;
  ephemeralPubKeyB64: string | null;
  maxEpoch: number | null;
  randomness: string | null;
} | null> {
  await ensureMobileSessionsSchema();
  const row = await db().execute({
    sql: `SELECT jwt, salt, ephemeral_pubkey_b64, max_epoch, randomness
          FROM mobile_sessions
          WHERE user_id = ? AND revoked = 0 AND expires_at > ?
            AND jwt IS NOT NULL AND salt IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`,
    args: [userId, Date.now()],
  });
  const r = row.rows[0] as unknown as {
    jwt: string;
    salt: string;
    ephemeral_pubkey_b64: string | null;
    max_epoch: number | null;
    randomness: string | null;
  } | undefined;
  if (!r) return null;
  return {
    jwt: decryptAtRest(r.jwt) as string,
    salt: decryptAtRest(r.salt) as string,
    ephemeralPubKeyB64: r.ephemeral_pubkey_b64,
    maxEpoch: r.max_epoch,
    randomness: r.randomness,
  };
}

/**
 * Pull the user id from either a session cookie OR a Bearer header.
 * Used by mobile-aware API routes to accept both clients without
 * duplicating logic.
 */
export async function readEntryIdFromRequest(req: Request): Promise<number | null> {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    return verifyMobileBearer(token);
  }
  // Fall back to cookie-based session — leaves existing web flows intact.
  const { readSessionEntryId } = await import("./session");
  return readSessionEntryId();
}

/**
 * True when the request authenticates via a Bearer header (i.e. the
 * iOS app). False for cookie-based web sessions. Lets routes decide
 * which signing-context source to use.
 */
export function isMobileRequest(req: Request): boolean {
  return req.headers.get("authorization")?.startsWith("Bearer ") ?? false;
}
