import { poseidonHash } from "@mysten/sui/zklogin";
/**
 * Talise shielded-pool SDK, deterministic key derivation.
 *
 * Importable from both server and client (no `server-only`, no Node-only deps).
 * NO new npm deps: uses Web Crypto (`globalThis.crypto.subtle`) + bigint only.
 *
 * Key model (PRIVACY-BUILD-PLAN.md Workstream C):
 *   spendingKey = hash(sign(FIXED_MSG)) mod r   (r = BN254 scalar field order)
 *   viewingKey  = Poseidon1(spendingKey)
 *   publicKey   = derived from spendingKey (commitment owner field)
 *
 * The user signs ONE fixed personal message with their zkLogin/wallet key; the
 * note master is the SHA-256 of that signature reduced mod r. This is
 * deterministic across devices (re-sign-in → re-derive → re-scan), so it is the
 * recovery rail.
 *
 * CRYPTO STATUS:
 *   • spendingKey derivation (sign → SHA-256 → mod r): REAL.
 *   • viewingKey = Poseidon1(spendingKey): STUBBED, see `poseidon1` below.
 *     Needs a BN254 Poseidon impl byte-identical to `sui::poseidon_bn254`.
 *   • publicKey: STUBBED, placeholder pending the circuit's pubkey definition.
 */

/** BN254 scalar field order r. Reductions for the note field live here. */
export const BN254_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * The fixed message the user signs to derive their note master. MUST be stable
 * forever, changing it orphans every existing note. Domain-separated.
 */
export const SHIELD_KEY_DERIVATION_MESSAGE =
  "talise.shield.note-master.v1";

export type ShieldKeypair = {
  /** Note spending key, a BN254 scalar. Keep secret; never leaves the device. */
  spendingKey: bigint;
  /** Viewing key, lets a holder trial-decrypt notes without spend authority. */
  viewingKey: bigint;
  /** Public key field element bound into note commitments. */
  publicKey: bigint;
};

/** Signs `SHIELD_KEY_DERIVATION_MESSAGE` and returns the raw signature bytes. */
export type PersonalMessageSigner = (message: Uint8Array) => Promise<Uint8Array>;

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  return acc;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("WebCrypto subtle unavailable; cannot derive shield keys");
  }
  // Copy into a fresh ArrayBuffer-backed view so the BufferSource type is exact
  // across DOM/Node lib variants.
  const buf = new Uint8Array(data).buffer;
  const digest = await subtle.digest("SHA-256", buf);
  return new Uint8Array(digest);
}

/**
 * Derive the shield keypair from a 32-byte NOTE MASTER seed, the recoverable,
 * user-controlled secret. For seedless zkLogin users the note master is
 * generated ONCE (CSPRNG) and persisted to two recovery rails (device keychain
 * + OAuth-bound server escrow); recovery = restore the master → re-derive →
 * re-scan. This is the non-custodial root: the seed never leaves the user's
 * device, and the keypair is a pure function of it, so it is identical on every
 * device that restores the same master.
 *
 *   spendingKey = SHA-256(noteMaster) mod r
 *   viewingKey  = Poseidon1(spendingKey)
 *   publicKey   = Poseidon1(spendingKey)   (note owner field; matches the circuit)
 */
export async function deriveShieldKeypairFromSeed(
  noteMaster: Uint8Array
): Promise<ShieldKeypair> {
  if (noteMaster.length < 16) {
    throw new Error("note master too short (need ≥16 bytes of entropy)");
  }
  const hash = await sha256(noteMaster);
  const spendingKey = bytesToBigIntBE(hash) % BN254_SCALAR_FIELD;
  const viewingKey = poseidon1(spendingKey);
  const publicKey = poseidon1(spendingKey);
  return { spendingKey, viewingKey, publicKey };
}

/**
 * Derive the shield keypair from a personal-message signer. Legacy path, the
 * signature is treated as the note-master seed. Prefer
 * {@link deriveShieldKeypairFromSeed} with a persisted, recoverable note master
 * (a raw signature isn't stable across zkLogin sessions, so it can't be the
 * recovery root).
 */
export async function deriveShieldKeypair(
  sign: PersonalMessageSigner
): Promise<ShieldKeypair> {
  const msg = new TextEncoder().encode(SHIELD_KEY_DERIVATION_MESSAGE);
  const sig = await sign(msg);
  return deriveShieldKeypairFromSeed(sig);
}

/**
 * NIST P-256 (secp256r1) group order n. The ECIES enc scalar lives in [1, n-1].
 * Duplicated from encrypt.ts's curve params on purpose: keys.ts must not import
 * from encrypt.ts (encrypt.ts imports from keys.ts, avoid a cycle).
 */
const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/**
 * Domain-separation tag mixed into the ECIES encryption scalar so it is a
 * distinct secret from the spending/viewing keys (a leaked enc scalar must not
 * reveal spend authority). Stable forever, changing it orphans published
 * encryption public keys.
 */
const SHIELD_ENC_KEY_TAG = "talise.shield.enc-scalar.v1";

/**
 * Derive the recipient's ECIES encryption PRIVATE scalar `d` deterministically
 * from the shield spending key, so it is recoverable on any device (re-sign-in
 * → re-derive → re-scan), exactly like the viewing key. `d = SHA-256(tag ‖
 * spendingKey_32BE) mod n` with `n` = P-256 group order, rejection-resampling
 * the (astronomically unlikely) `0` case via a counter.
 *
 * The matching PUBLIC key (what the recipient publishes for senders to encrypt
 * to) is `d·G`, see encrypt.ts `encPublicKeyFromScalar`.
 *
 * REAL: deterministic, recoverable, domain-separated from the spend key.
 */
export async function deriveShieldEncScalar(spendingKey: bigint): Promise<bigint> {
  const tag = new TextEncoder().encode(SHIELD_ENC_KEY_TAG);
  const skBytes = new Uint8Array(32);
  let v = spendingKey % BN254_SCALAR_FIELD;
  for (let i = 31; i >= 0; i--) {
    skBytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  for (let counter = 0; counter < 256; counter++) {
    const buf = new Uint8Array(tag.length + skBytes.length + 1);
    buf.set(tag, 0);
    buf.set(skBytes, tag.length);
    buf[buf.length - 1] = counter;
    const hash = await sha256(buf);
    const d = bytesToBigIntBE(hash) % P256_ORDER;
    if (d !== 0n) return d;
  }
  throw new Error("unreachable: failed to derive enc scalar");
}

/**
 * Poseidon1 of a single BN254 field element, REAL. Delegates to `poseidonStub`
 * (`@mysten/sui/zklogin` poseidonHash), verified byte-identical to the circuit's
 * `poseidon_opt` hash1 (parity gate, 2026-06-17). Used for the note pubkey and
 * the viewing key.
 */
export function poseidon1(x: bigint): bigint {
  return poseidonStub([x]);
}

/**
 * REAL Poseidon over BN254, `@mysten/sui/zklogin`'s `poseidonHash`, the
 * circomlib parameterization that is byte-identical to `sui::poseidon_bn254`
 * (verified for arity-2 against all 27 on-chain `empty_subtree_hashes`, the
 * Phase-0 gate). Used for note commitments (Poseidon4), nullifiers (Poseidon3),
 * and the viewing key (Poseidon1). PARITY VERIFIED 2026-06-17: arity-1/3/4 are
 * byte-identical to the circuit's `poseidon_opt` (known-answer gate in
 * circuit/tests/poseidon_parity.rs, poseidonHash([1]) / ([1,2,3]) / ([1,2,3,4])
 * equal hash1/hash3/hash4). So SDK-assembled witnesses satisfy the circuit and
 * verify on-chain.
 */
export function poseidonStub(inputs: bigint[]): bigint {
  return poseidonHash(inputs);
}
