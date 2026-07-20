import "server-only";

import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { storeBlob, readBlob } from "./walrus";

/**
 * Private notes on claimable money links.
 *
 * The sender can attach a short message to a money link. We encrypt it, store
 * the ciphertext on Walrus, and record only the blob id on the cheque row, so
 * the note is private (Talise's DB never holds the plaintext) and the blob is
 * meaningless to anyone scanning Walrus.
 *
 * KEY DERIVATION (today): the content key is derived from the cheque's claim
 * secret, which lives ONLY in the share link (`/c/<id>#<secret>`). So exactly
 * whoever holds the link can open the note, same trust model as the funds.
 *
 * UPGRADE PATH (Seal): swap `deriveKey` for Mysten Seal identity-based / threshold
 * encryption keyed to the cheque id, gated by a `seal_approve` policy in
 * cheque.move (e.g. "approve if claimer matches the on-chain Cheque recipient").
 * The Walrus storage + blob-id-on-row plumbing below stays identical.
 */

const ALG = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const VERSION = 0x01;
export const MAX_NOTE_CHARS = 280;

function deriveKey(secret: string): Buffer {
  // HKDF-ish: HMAC-SHA256 over the claim secret with a fixed info label.
  return createHmac("sha256", createHash("sha256").update("talise-cheque-note").digest())
    .update(secret)
    .digest()
    .subarray(0, 32);
}

/** Encrypt + persist a note to Walrus; returns the blob id (or null if empty). */
export async function sealAndStoreNote(
  secret: string,
  note: string | null | undefined,
  opts: { epochs?: number } = {}
): Promise<string | null> {
  const text = (note ?? "").trim();
  if (!text) return null;
  const plaintext = Buffer.from(text.slice(0, MAX_NOTE_CHARS), "utf8");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, deriveKey(secret), iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // sealed blob = [version | iv | ciphertext | tag]
  const sealed = Buffer.concat([Buffer.from([VERSION]), iv, ct, tag]);
  return storeBlob(new Uint8Array(sealed), { epochs: opts.epochs });
}

/** Fetch a note blob from Walrus + decrypt with the claim secret. Null on any failure. */
export async function fetchAndOpenNote(
  secret: string,
  blobId: string | null | undefined
): Promise<string | null> {
  if (!blobId) return null;
  try {
    const sealed = Buffer.from(await readBlob(blobId));
    if (sealed.length < 1 + IV_LEN + TAG_LEN || sealed[0] !== VERSION) return null;
    const iv = sealed.subarray(1, 1 + IV_LEN);
    const tag = sealed.subarray(sealed.length - TAG_LEN);
    const ct = sealed.subarray(1 + IV_LEN, sealed.length - TAG_LEN);
    const decipher = createDecipheriv(ALG, deriveKey(secret), iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(ct), decipher.final()]);
    return out.toString("utf8");
  } catch {
    return null;
  }
}
