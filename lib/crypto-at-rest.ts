import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Application-level encryption for sensitive columns AT REST.
 *
 * Why: a few columns hold material that turns a DB read into a compromise -
 * zkLogin `salt` (+ the JWT alongside it) is signing material; bank account
 * numbers are PII. Postgres access is already gated, but defense-in-depth says
 * a leaked dump / compromised pooler shouldn't hand over signing seeds or PANs.
 *
 * Design goals (all satisfied):
 *  1. OPT-IN + ZERO-RISK ROLLOUT. Encryption only activates when
 *     `DB_ENCRYPTION_KEY` is set (in .env.local locally, Vercel env in prod).
 *     With no key, encrypt() and decrypt() are pure pass-throughs, so behaviour
 *     is byte-for-byte identical to today until you deliberately turn it on.
 *  2. TRANSPARENT / BACKWARD-COMPATIBLE. decrypt() returns un-prefixed values
 *     unchanged, so already-stored plaintext rows keep working after the key is
 *     set, new writes encrypt, old rows migrate lazily (or via a backfill).
 *     This means wiring a read site you missed can't break anything: it just
 *     reads plaintext.
 *  3. AUTHENTICATED. AES-256-GCM (random 12-byte IV per value + 16-byte tag),
 *     so tampering is detected, not silently decrypted to garbage.
 *
 * Key format: `DB_ENCRYPTION_KEY` is 32 bytes as base64 or hex. Generate with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 * Store it ONLY in .env.local (gitignored) and Vercel env, never in git.
 */

const PREFIX = "enc:v1:";

let _key: Buffer | null | undefined; // undefined = not yet resolved

/** Resolve the 32-byte key once. Returns null when encryption is disabled. */
function key(): Buffer | null {
  if (_key !== undefined) return _key;
  const raw = process.env.DB_ENCRYPTION_KEY?.trim();
  if (!raw) {
    _key = null;
    return null;
  }
  // Accept base64 or hex; require exactly 32 bytes (AES-256).
  let buf: Buffer;
  try {
    buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  } catch {
    throw new Error("DB_ENCRYPTION_KEY is not valid base64/hex");
  }
  if (buf.length !== 32) {
    throw new Error(`DB_ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length})`);
  }
  _key = buf;
  return _key;
}

/** True if `value` is one of our ciphertexts. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/**
 * Encrypt a value for storage. No-op (returns input) when encryption is
 * disabled or the value is null/empty/already-encrypted.
 */
export function encryptAtRest(plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === "") return plaintext ?? null;
  if (isEncrypted(plaintext)) return plaintext;
  const k = key();
  if (!k) return plaintext; // disabled → store plaintext (current behaviour)
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

/**
 * Decrypt a stored value. Returns plaintext unchanged (so un-migrated rows and
 * key-disabled deployments keep working). Throws only on a corrupt/tampered
 * ciphertext, which should never silently pass.
 */
export function decryptAtRest(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  if (!isEncrypted(stored)) return stored; // plaintext passthrough
  const k = key();
  if (!k) {
    throw new Error("DB_ENCRYPTION_KEY is unset but an encrypted value was read");
  }
  const blob = Buffer.from(stored.slice(PREFIX.length), "base64");
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Whether at-rest encryption is currently active (key present). */
export function encryptionEnabled(): boolean {
  return key() !== null;
}
