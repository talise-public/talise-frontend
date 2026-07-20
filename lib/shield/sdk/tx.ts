/**
 * Talise shielded-pool SDK, transact PTB builder.
 *
 * Assembles the `transact` PTB that the relayer (`/api/shield/relay`) will
 * validate + sponsor. The shape MUST match `validate-commands.ts` exactly:
 *
 *   proof::new(...)         → Proof
 *   ext_data::new(...)      → ExtData    (relayer + relayer_fee read here)
 *   shielded_pool::transact(self, registry, deposit, proof, ext_data)
 *
 * The relayer is set as `ExtData.relayer` (and is the eventual tx sender), so
 * the on-chain `ext_data::assert_relayer(sender == relayer)` passes.
 *
 * CRYPTO STATUS: the Groth16 PROVE call is now wired. `proveTransact()` takes a
 * fully-assembled circuit `ProofInput` (note inputs + Merkle paths + outputs),
 * runs the WASM Groth16 prover in a Web Worker (see prover.ts / prover.worker.ts,
 * real browser entropy), and returns the `ProofInputs` (proof points + public
 * signals as bigints) that `buildTransact` assembles into the transact PTB.
 */

import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { prove, type ProofInput, type ProofOutput } from "./prover";

/** Proof inputs as produced by the WASM prover. All u256 as bigint. */
export type ProofInputs = {
  /** Compressed Groth16 proof points (proofA‖proofB‖proofC), 128 bytes. */
  proofPoints: Uint8Array;
  /** Targeted Merkle root. */
  root: bigint;
  /** Signed public value (deposit: value-fee; withdraw: r - value). */
  publicValue: bigint;
  inputNullifier0: bigint;
  inputNullifier1: bigint;
  outputCommitment0: bigint;
  outputCommitment1: bigint;
};

/** Cleartext external data for the public leg. */
export type ExtDataInput = {
  /** Cleartext magnitude of the public leg (0 for internal transfer). */
  value: bigint;
  /** true => deposit (into pool); false => withdraw. */
  valueSign: boolean;
  /** The relayer address (from GET /api/shield/relayer). */
  relayer: string;
  /** Relayer fee, must be <= the relayer's advertised max. */
  relayerFee: bigint;
  encryptedOutput0: Uint8Array;
  encryptedOutput1: Uint8Array;
};

export type BuildTransactParams = {
  /** Pinned shielded-pool package id. */
  packageId: string;
  /** CoinType type tag (e.g. the USDsui struct tag) for the generic call. */
  coinType: string;
  /** The shared `ShieldedPool<CoinType>` object id. */
  poolObjectId: string;
  /**
   * The shared `talise::compliance::ComplianceRegistry` object id. OPTIONAL:
   * the deployed (decoupled) pool's `transact(self, deposit, proof, ext)` takes
   * NO registry, so omit it there. Supply it only against a compliance-wired
   * pool whose `transact` signature is `(self, registry, deposit, proof, ext)`.
   */
  complianceRegistryId?: string;
  /** The pool address as a field element (bound into the proof, anti-replay). */
  poolAddress: string;
  proof: ProofInputs;
  ext: ExtDataInput;
  /**
   * Deposit coin object id for the deposit leg. The on-chain `transact` takes a
   * `Coin<CoinType>` by value, so EVERY leg needs one:
   *   • deposit  → a real coin of `value` (the funds entering the pool),
   *   • withdraw / internal-transfer → a ZERO coin. There is no `coin::zero`
   *     MoveCall on the relayer allowlist, so the builder splits `[0]` off
   *     {@link zeroCoinSourceId} (a relayer-owned coin of CoinType) via the
   *     allowlisted `SplitCoins` glue.
   * Pass `depositCoinId` for the deposit leg; pass `zeroCoinSourceId` otherwise.
   */
  depositCoinId?: string;
  /**
   * A relayer-owned `Coin<CoinType>` object id to split a zero coin from on the
   * withdraw / internal-transfer legs (when `depositCoinId` is absent). Restored
   * to its full value by the `[0]` split, so it is non-destructive.
   */
  zeroCoinSourceId?: string;
  /**
   * Where the `transact` RETURN coin goes. On withdraw this carries the
   * unshielded funds (→ the recipient); on deposit / internal-transfer it is a
   * zero coin (→ harmlessly the relayer). Defaults to the relayer.
   */
  outputRecipient?: string;
};

/** Map a wasm `ProofOutput` into the `ProofInputs` the PTB builder consumes. */
function proofOutputToInputs(out: ProofOutput): ProofInputs {
  // public_inputs (decimal strings), allocation order:
  // [pool/vortex, root, public_value, null0, null1, comm0, comm1, hashed_secret]
  const pi = out.publicInputs;
  if (pi.length !== 8) {
    throw new Error(`expected 8 public inputs, got ${pi.length}`);
  }
  const proofPoints = Uint8Array.from(
    out.proofSerializedHex
      .match(/.{1,2}/g)!
      .map((b) => parseInt(b, 16))
  );
  if (proofPoints.length !== 128) {
    throw new Error(`proof points must be 128 bytes, got ${proofPoints.length}`);
  }
  return {
    proofPoints,
    root: BigInt(pi[1]),
    publicValue: BigInt(pi[2]),
    inputNullifier0: BigInt(pi[3]),
    inputNullifier1: BigInt(pi[4]),
    outputCommitment0: BigInt(pi[5]),
    outputCommitment1: BigInt(pi[6]),
  };
}

/**
 * Close the WASM-prove seam: run the Groth16 prover over a fully-assembled
 * circuit `ProofInput` (note inputs + Merkle paths + outputs) and return the
 * `ProofInputs` for {@link buildTransact}. Proving runs off the main thread in a
 * Web Worker. The pool/vortex public signal (index 0) is bound into the proof
 * and re-supplied to `buildTransact` as `poolAddress`, so it is not echoed here.
 */
export async function proveTransact(input: ProofInput): Promise<ProofInputs> {
  const out = await prove(input);
  return proofOutputToInputs(out);
}

/**
 * Build the `transact` PTB. Returns an unbuilt `Transaction` (sender/gas left
 * for the relayer to set). Mirrors the allowed command shape exactly.
 */
export function buildTransact(params: BuildTransactParams): Transaction {
  const tx = new Transaction();
  const { packageId, coinType, proof, ext } = params;

  // proof::new<CoinType>(pool, proof_points, root, public_value,
  //                      null0, null1, comm0, comm1) -> Proof
  const proofArg = tx.moveCall({
    target: `${packageId}::proof::new`,
    typeArguments: [coinType],
    arguments: [
      tx.pure.address(params.poolAddress),
      tx.pure(bcs.vector(bcs.u8()).serialize(proof.proofPoints)),
      tx.pure(bcs.u256().serialize(proof.root)),
      tx.pure(bcs.u256().serialize(proof.publicValue)),
      tx.pure(bcs.u256().serialize(proof.inputNullifier0)),
      tx.pure(bcs.u256().serialize(proof.inputNullifier1)),
      tx.pure(bcs.u256().serialize(proof.outputCommitment0)),
      tx.pure(bcs.u256().serialize(proof.outputCommitment1)),
    ],
  });

  // ext_data::new(value, value_sign, relayer, relayer_fee, enc0, enc1) -> ExtData
  // Argument order is load-bearing: validate-commands reads relayer @2, fee @3.
  const extArg = tx.moveCall({
    target: `${packageId}::ext_data::new`,
    arguments: [
      tx.pure(bcs.u64().serialize(ext.value)),
      tx.pure(bcs.bool().serialize(ext.valueSign)),
      tx.pure.address(ext.relayer),
      tx.pure(bcs.u64().serialize(ext.relayerFee)),
      tx.pure(bcs.vector(bcs.u8()).serialize(ext.encryptedOutput0)),
      tx.pure(bcs.vector(bcs.u8()).serialize(ext.encryptedOutput1)),
    ],
  });

  // The deposit coin handed to `transact` by value.
  //   • deposit leg → the caller's real coin object (`depositCoinId`).
  //   • withdraw / internal-transfer → a ZERO coin. `coin::zero` is NOT on the
  //     relayer allowlist, so we split `[0]` off a relayer-owned coin of
  //     CoinType (`zeroCoinSourceId`) via the allowlisted SplitCoins glue. The
  //     source coin is left whole (a 0-amount split).
  let depositCoin;
  if (params.depositCoinId) {
    depositCoin = tx.object(params.depositCoinId);
  } else if (params.zeroCoinSourceId) {
    const [zero] = tx.splitCoins(tx.object(params.zeroCoinSourceId), [
      tx.pure.u64(0n),
    ]);
    depositCoin = zero;
  } else {
    throw new Error(
      "buildTransact: a deposit leg needs depositCoinId; a withdraw/transfer " +
        "leg needs zeroCoinSourceId (a relayer coin to split a zero coin from)"
    );
  }

  // shielded_pool::transact<CoinType>(self, [registry,] deposit, proof, ext) -> Coin
  // The deployed decoupled pool takes NO registry; a compliance-wired pool does.
  const transactArgs = params.complianceRegistryId
    ? [
        tx.object(params.poolObjectId),
        tx.object(params.complianceRegistryId),
        depositCoin,
        proofArg,
        extArg,
      ]
    : [tx.object(params.poolObjectId), depositCoin, proofArg, extArg];
  const out = tx.moveCall({
    target: `${packageId}::shielded_pool::transact`,
    typeArguments: [coinType],
    arguments: transactArgs,
  });

  // `transact` returns a Coin<CoinType> by value, it MUST be consumed. On a
  // withdraw it holds the unshielded funds (→ recipient); on deposit / internal
  // it is a zero coin (→ relayer, harmless). Either way, transfer it out.
  tx.transferObjects([out], tx.pure.address(params.outputRecipient ?? params.ext.relayer));

  return tx;
}
