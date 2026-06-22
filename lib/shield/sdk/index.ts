/**
 * Talise shielded-pool client SDK (Workstream C).
 *
 * Server + client importable, NO new deps (uses @mysten/sui + Web Crypto).
 * Clean public surface:
 *   • deriveShieldKeypair — note keys from a personal-message signer
 *   • makeNote / noteCommitment — build a note + its commitment
 *   • buildTransact — assemble the relayer-validatable transact PTB
 *   • scanNotes — trial-decrypt the commitments feed
 *
 * CRYPTO: note ENCRYPTION is REAL (P-256 ECIES + AES-256-GCM, see encrypt.ts).
 * Poseidon and the Groth16 prover are still clearly STUBBED with TODOs (see
 * keys.ts, tx.ts). Replace before any real use — the Poseidon byte-match to
 * `sui::poseidon_bn254` is THE critical gate.
 */

export {
  deriveShieldKeypair,
  deriveShieldKeypairFromSeed,
  deriveShieldEncScalar,
  poseidon1,
  BN254_SCALAR_FIELD,
  SHIELD_KEY_DERIVATION_MESSAGE,
} from "./keys";
export type { ShieldKeypair, PersonalMessageSigner } from "./keys";

export {
  makeNote,
  noteCommitment,
  noteNullifier,
  randomField,
} from "./note";
export type { Note, SpendableNote } from "./note";

export {
  encryptNote,
  decryptNote,
  encodeNotePlaintext,
  decodeNotePlaintext,
  encPublicKeyFromScalar,
} from "./encrypt";
export type { RecipientEncKey } from "./encrypt";

export { scanNotes, tryDecryptRow } from "./scan";
export type { CommitmentRow, ScanOptions } from "./scan";

export { buildTransact, proveTransact } from "./tx";
export type { ProofInputs, ExtDataInput, BuildTransactParams } from "./tx";

export {
  prove,
  verifyProof,
  preloadProvingKey,
  warmUp,
  loadVerifyingKey,
  SHIELD_ASSETS,
  PUBLIC_INPUT_ORDER,
} from "./prover";
export type { ProofOutput, ProofInput } from "./prover";

export {
  shieldDeposit,
  shieldWithdraw,
  shieldTransfer,
} from "./flow";
export type {
  ShieldFlowConfig,
  FlowInputNote,
  FlowOutputNote,
} from "./flow";
