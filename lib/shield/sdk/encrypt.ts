/**
 * Talise shielded-pool SDK, note encryption (REAL ECIES to recipient enc key).
 *
 * Each `transact` carries two encrypted note outputs in `ExtData`
 * (`encrypted_output0/1`). The recipient trial-decrypts them (see scan.ts) with
 * their encryption private key to discover incoming notes. The sender encrypts
 * to the recipient's published encryption public key.
 *
 * ── Scheme: ECIES over NIST P-256 (secp256r1) ───────────────────────────────
 *
 *   ephemeral keypair (e, E=e·G), fresh per note, from a CSPRNG
 *   shared = ECDH(e, R) = (e·R).x, R = recipient enc public key = d·G
 *   key    = HKDF-SHA256(shared, salt=E_bytes, info="talise.shield.ecies.v1")
 *   ct,tag = AES-256-GCM(key, iv, plaintext)
 *   blob   = E_bytes(65) ‖ iv(12) ‖ ciphertext+tag(128+16)
 *
 * Confidential (only the holder of `d` can recompute `shared`), authenticated
 * (GCM tag), and forward-fresh (a new ephemeral `e` per note). Decryption is a
 * pure function returning `null` on any failure, so scan.ts can trial-decrypt
 * every blob and silently skip the ones not addressed to it.
 *
 * ── Why P-256 (not X25519) ──────────────────────────────────────────────────
 *
 * WebCrypto `subtle` supports `ECDH/P-256` in EVERY target runtime we ship to
 * (browsers, the Next.js node + edge runtimes, and React-Native crypto
 * polyfills). WebCrypto `X25519` is comparatively new and is NOT yet present in
 * several of those (older Safari, some edge/serverless runtimes), which would
 * break recoverability on a recipient's other device. We therefore standardise
 * on P-256. The curve arithmetic below is the PUBLISHED NIST P-256 (FIPS 186-4)
 *, used only to (a) derive the recipient's static pubkey deterministically
 * from the bigint enc scalar (so it is recoverable, like the viewing key) and
 * (b) compute the raw ECDH point; the AEAD + KDF are WebCrypto. We do NOT
 * hand-roll any non-standard curve.
 *
 * The exported function names/signatures are unchanged from the stub so scan.ts
 * and tx.ts keep compiling: `decryptNote(blob, encPrivKey: bigint)` and
 * `encryptNote(note, recipientEncKey)` where the recipient key is either the
 * recipient's public-key bytes (normal send path) or the bigint enc scalar
 * (self-encryption / tests, the pubkey is derived on the fly).
 */

import { BN254_SCALAR_FIELD } from "./keys";
import type { Note } from "./note";

// ── public surface (stable) ─────────────────────────────────────────────────

/** Serialized note plaintext (amount, pubkey, blinding, pool) as 4×32B BE. */
export function encodeNotePlaintext(note: Note): Uint8Array {
  const out = new Uint8Array(128);
  writeField(out, 0, note.amount);
  writeField(out, 32, note.pubkey);
  writeField(out, 64, note.blinding);
  writeField(out, 96, note.pool);
  return out;
}

export function decodeNotePlaintext(bytes: Uint8Array): Note | null {
  if (bytes.length !== 128) return null;
  return {
    amount: readField(bytes, 0),
    pubkey: readField(bytes, 32),
    blinding: readField(bytes, 64),
    pool: readField(bytes, 96),
  };
}

/**
 * The recipient's ECIES key, as accepted by `encryptNote`:
 *   • `Uint8Array`, the recipient's 65-byte uncompressed P-256 public key
 *     (0x04‖X‖Y), as published. This is the normal send path.
 *   • `bigint`   , the recipient's enc private scalar; the public key is
 *     derived from it. Convenient for self-encryption and tests.
 */
export type RecipientEncKey = Uint8Array | bigint;

/**
 * Derive the recipient encryption PUBLIC key (65-byte uncompressed P-256 point
 * 0x04‖X‖Y) from the enc private scalar `d`. Deterministic and recoverable:
 * derive `d` from the shield spending key (see keys.ts `deriveShieldEncScalar`),
 * compute `d·G`, publish the result so senders can encrypt to it.
 */
export function encPublicKeyFromScalar(d: bigint): Uint8Array {
  const e = normalizeScalar(d);
  const P = pointMul(G, e);
  return encodePoint(P);
}

/**
 * Encrypt a note to a recipient. ECIES over P-256 + AES-256-GCM (see file
 * header). Output = ephemeralPubKey(65) ‖ iv(12) ‖ ciphertext+tag(144).
 *
 * `recipient` is either the recipient's public-key bytes (normal path) or the
 * recipient's enc scalar (`bigint`, self/test path).
 */
export async function encryptNote(
  note: Note,
  recipient: RecipientEncKey
): Promise<Uint8Array> {
  const subtle = requireSubtle();
  const R = toRecipientPoint(recipient); // recipient public point (validated)

  // Fresh ephemeral keypair e, E = e·G.
  const e = randomScalar();
  const Ebytes = encodePoint(pointMul(G, e));

  // Raw ECDH shared secret = x-coordinate of e·R, 32B BE.
  const shared = sharedSecretX(R, e);

  const key = await deriveAesKey(subtle, shared, Ebytes);
  const iv = randomBytes(IV_LEN);
  const pt = encodeNotePlaintext(note);
  const ctBuf = await subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBufferView(iv) },
    key,
    toArrayBufferView(pt)
  );
  const ct = new Uint8Array(ctBuf);

  const out = new Uint8Array(Ebytes.length + iv.length + ct.length);
  out.set(Ebytes, 0);
  out.set(iv, Ebytes.length);
  out.set(ct, Ebytes.length + iv.length);
  return out;
}

/**
 * Trial-decrypt an ECIES blob with the recipient enc private scalar. Returns
 * the note, or `null` on any failure (bad length, point off-curve, GCM auth
 * failure, malformed plaintext, or fields out of the BN254 field). Pure: never
 * throws on a non-matching blob, so scan.ts can sweep the whole feed.
 *
 * Signature kept `(blob, key: bigint)` so scan.ts's `decryptNote(ct, viewingKey)`
 * keeps compiling, the bigint is the recipient enc private scalar.
 */
export async function decryptNote(
  blob: Uint8Array,
  recipientEncPrivKey: bigint
): Promise<Note | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  if (blob.length !== POINT_LEN + IV_LEN + CT_LEN) return null;

  try {
    const Ebytes = blob.subarray(0, POINT_LEN);
    const iv = blob.subarray(POINT_LEN, POINT_LEN + IV_LEN);
    const ct = blob.subarray(POINT_LEN + IV_LEN);

    const E = decodePoint(Ebytes); // ephemeral pub (validated on-curve)
    const d = normalizeScalar(recipientEncPrivKey);
    const shared = sharedSecretX(E, d); // d·E = e·R, same x

    const key = await deriveAesKey(subtle, shared, Ebytes);
    const ptBuf = await subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBufferView(iv) },
      key,
      toArrayBufferView(ct)
    );
    const note = decodeNotePlaintext(new Uint8Array(ptBuf));
    if (!note) return null;
    if (
      note.amount >= BN254_SCALAR_FIELD ||
      note.pubkey >= BN254_SCALAR_FIELD ||
      note.blinding >= BN254_SCALAR_FIELD ||
      note.pool >= BN254_SCALAR_FIELD
    ) {
      return null;
    }
    return note;
  } catch {
    // GCM auth failure (wrong key), off-curve point, etc., not our note.
    return null;
  }
}

// ── AEAD / KDF (WebCrypto) ──────────────────────────────────────────────────

const POINT_LEN = 65; // 0x04 ‖ X(32) ‖ Y(32)
const IV_LEN = 12; // AES-GCM 96-bit nonce
const PT_LEN = 128; // 4 × 32B fields
const CT_LEN = PT_LEN + 16; // + 128-bit GCM tag
const HKDF_INFO = new TextEncoder().encode("talise.shield.ecies.v1");

function requireSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("WebCrypto subtle unavailable; cannot encrypt note");
  }
  return subtle;
}

/**
 * HKDF-SHA256(ikm=shared, salt=ephemeralPubKey, info="…ecies.v1") → AES-256 key.
 * Binding the salt to the ephemeral public key domain-separates per-note keys.
 */
async function deriveAesKey(
  subtle: SubtleCrypto,
  shared: Uint8Array,
  ephemeralPub: Uint8Array
): Promise<CryptoKey> {
  const ikm = await subtle.importKey(
    "raw",
    toArrayBufferView(shared),
    "HKDF",
    false,
    ["deriveKey"]
  );
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBufferView(ephemeralPub),
      info: toArrayBufferView(HKDF_INFO),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// ── NIST P-256 (secp256r1) point arithmetic, bigint only ────────────────────
//
// Published FIPS 186-4 / SEC 2 parameters. Used for deterministic pubkey
// derivation (d·G) and the raw ECDH point (k·P). Affine coords over Jacobian
// internally for cheap mul. This is the standard curve, NOT a custom one.

const P =
  0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn; // field prime
const A =
  0xffffffff00000001000000000000000000000000fffffffffffffffffffffffcn; // a = -3
const B =
  0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n; // group order
const GX =
  0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY =
  0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

/** Affine point; `null` = point at infinity. */
type Point = { x: bigint; y: bigint } | null;
const G: Point = { x: GX, y: GY };

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

/** Modular inverse via Fermat (P prime): a^(P-2) mod P. */
function invMod(a: bigint, m: bigint): bigint {
  return powMod(mod(a, m), m - 2n, m);
}

function powMod(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function pointAdd(p: Point, q: Point): Point {
  if (p === null) return q;
  if (q === null) return p;
  if (p.x === q.x) {
    if (mod(p.y + q.y, P) === 0n) return null; // p = -q
    return pointDouble(p);
  }
  const lambda = mod((q.y - p.y) * invMod(q.x - p.x, P), P);
  const x = mod(lambda * lambda - p.x - q.x, P);
  const y = mod(lambda * (p.x - x) - p.y, P);
  return { x, y };
}

function pointDouble(p: Point): Point {
  if (p === null) return null;
  if (p.y === 0n) return null;
  const lambda = mod((3n * p.x * p.x + A) * invMod(2n * p.y, P), P);
  const x = mod(lambda * lambda - 2n * p.x, P);
  const y = mod(lambda * (p.x - x) - p.y, P);
  return { x, y };
}

function pointMul(p: Point, k: bigint): Point {
  let result: Point = null;
  let addend = p;
  let n = mod(k, N);
  while (n > 0n) {
    if (n & 1n) result = pointAdd(result, addend);
    addend = pointDouble(addend);
    n >>= 1n;
  }
  return result;
}

/** Is the affine point on the curve y² = x³ + ax + b (mod P)? */
function onCurve(p: Point): boolean {
  if (p === null) return false;
  if (p.x < 0n || p.x >= P || p.y < 0n || p.y >= P) return false;
  const lhs = mod(p.y * p.y, P);
  const rhs = mod(p.x * p.x * p.x + A * p.x + B, P);
  return lhs === rhs;
}

/** Encode an affine point as 0x04 ‖ X(32) ‖ Y(32). */
function encodePoint(p: Point): Uint8Array {
  if (p === null) throw new Error("cannot encode point at infinity");
  const out = new Uint8Array(POINT_LEN);
  out[0] = 0x04;
  writeBigUintBE(out, 1, p.x, 32);
  writeBigUintBE(out, 33, p.y, 32);
  return out;
}

/** Decode + validate a 65-byte uncompressed point. Throws if invalid. */
function decodePoint(bytes: Uint8Array): Point {
  if (bytes.length !== POINT_LEN || bytes[0] !== 0x04) {
    throw new Error("bad point encoding");
  }
  const x = readBigUintBE(bytes, 1, 32);
  const y = readBigUintBE(bytes, 33, 32);
  const p: Point = { x, y };
  if (!onCurve(p)) throw new Error("point not on curve");
  return p;
}

/** Raw ECDH: x-coordinate of (scalar · point), 32B BE. Rejects identity. */
function sharedSecretX(point: Point, scalar: bigint): Uint8Array {
  const s = pointMul(point, scalar);
  if (s === null) throw new Error("degenerate ECDH (point at infinity)");
  const out = new Uint8Array(32);
  writeBigUintBE(out, 0, s.x, 32);
  return out;
}

/** Reduce/validate a private scalar into [1, N-1]. */
function normalizeScalar(d: bigint): bigint {
  const s = mod(d, N);
  if (s === 0n) throw new Error("invalid enc scalar (≡0 mod n)");
  return s;
}

/** A uniform private scalar in [1, N-1] from the CSPRNG. */
function randomScalar(): bigint {
  for (;;) {
    const k = readBigUintBE(randomBytes(32), 0, 32);
    const s = k % N;
    if (s !== 0n) return s;
  }
}

/** Coerce the `RecipientEncKey` union into a validated public point. */
function toRecipientPoint(recipient: RecipientEncKey): Point {
  if (typeof recipient === "bigint") {
    return pointMul(G, normalizeScalar(recipient));
  }
  return decodePoint(recipient);
}

// ── byte / CSPRNG helpers ───────────────────────────────────────────────────

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  const c = globalThis.crypto;
  if (!c?.getRandomValues) {
    throw new Error("crypto.getRandomValues unavailable");
  }
  c.getRandomValues(out);
  return out;
}

/**
 * Copy into a view backed by an exact `ArrayBuffer` (not `SharedArrayBuffer`),
 * so the `BufferSource` type is precise across DOM/Node lib variants. Mirrors
 * the `new Uint8Array(data).buffer` idiom used in keys.ts.
 */
function toArrayBufferView(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(data.length);
  const view = new Uint8Array(buf);
  view.set(data);
  return view;
}

function writeBigUintBE(
  out: Uint8Array,
  offset: number,
  value: bigint,
  len: number
): void {
  let v = value;
  for (let i = len - 1; i >= 0; i--) {
    out[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function readBigUintBE(bytes: Uint8Array, offset: number, len: number): bigint {
  let acc = 0n;
  for (let i = 0; i < len; i++) acc = (acc << 8n) | BigInt(bytes[offset + i]);
  return acc;
}

// ── note-field I/O (BN254-reduced, 32B BE) ──────────────────────────────────

function writeField(out: Uint8Array, offset: number, value: bigint): void {
  let v = value % BN254_SCALAR_FIELD;
  for (let i = 31; i >= 0; i--) {
    out[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function readField(bytes: Uint8Array, offset: number): bigint {
  let acc = 0n;
  for (let i = 0; i < 32; i++) acc = (acc << 8n) | BigInt(bytes[offset + i]);
  return acc;
}
