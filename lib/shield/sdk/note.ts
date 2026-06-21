/**
 * Talise shielded-pool SDK — notes (commitment + nullifier).
 *
 * A NOTE is the private representation of value: a leaf commitment in the
 * height-26 Merkle tree. There is no wrapped coin.
 *
 *   commitment = Poseidon4(amount, pubkey, blinding, pool)
 *   nullifier  = Poseidon3(commitment, pathIndex, sig)
 *
 * (Matches the Workstream-B circuit + Workstream-A `proof.move` 8-input order.)
 *
 * CRYPTO STATUS: the Poseidon hashes are STUBBED (see keys.ts `poseidonStub`).
 * Real impl must be byte-identical to `sui::poseidon_bn254`.
 */

import { BN254_SCALAR_FIELD, poseidonStub } from "./keys";

export type Note = {
  /** Cleartext amount in CoinType base units (e.g. USDsui micros). */
  amount: bigint;
  /** Owner public key field element (note recipient). */
  pubkey: bigint;
  /** Random blinding factor (per-note, hides the amount). */
  blinding: bigint;
  /** The pool address as a field element (anti cross-pool replay). */
  pool: bigint;
};

/** A note plus its derived commitment + tree position, ready to spend/scan. */
export type SpendableNote = Note & {
  commitment: bigint;
  /** Leaf index in the Merkle tree once appended (null until known). */
  leafIndex: number | null;
};

/** Construct a note. `blinding` should come from a CSPRNG (see `randomField`). */
export function makeNote(params: {
  amount: bigint;
  pubkey: bigint;
  pool: bigint;
  blinding?: bigint;
}): Note {
  return {
    amount: params.amount % BN254_SCALAR_FIELD,
    pubkey: params.pubkey % BN254_SCALAR_FIELD,
    blinding: (params.blinding ?? randomField()) % BN254_SCALAR_FIELD,
    pool: params.pool % BN254_SCALAR_FIELD,
  };
}

/**
 * commitment = Poseidon4(amount, pubkey, blinding, pool).
 * STUBBED Poseidon — see keys.ts.
 */
export function noteCommitment(note: Note): bigint {
  return poseidonStub([note.amount, note.pubkey, note.blinding, note.pool]);
}

/**
 * nullifier = Poseidon3(commitment, pathIndex, sig).
 * `sig` binds the spending key so only the owner can derive the nullifier.
 * STUBBED Poseidon — see keys.ts.
 */
export function noteNullifier(params: {
  commitment: bigint;
  pathIndex: number | bigint;
  sig: bigint;
}): bigint {
  return poseidonStub([
    params.commitment,
    BigInt(params.pathIndex),
    params.sig,
  ]);
}

/**
 * A 254-bit random field element from a CSPRNG. REAL (Web Crypto). Used for
 * note blinding — distinct per note so two equal-amount notes have distinct
 * commitments.
 */
export function randomField(): bigint {
  const bytes = new Uint8Array(32);
  const c = globalThis.crypto;
  if (!c?.getRandomValues) {
    throw new Error("crypto.getRandomValues unavailable; cannot blind note");
  }
  c.getRandomValues(bytes);
  // Clear the top 2 bits so the value is < 2^254 < r (BN254 r is ~254 bits).
  bytes[0] &= 0x3f;
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  return acc % BN254_SCALAR_FIELD;
}
