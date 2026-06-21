import "server-only";

import { coinWithBalance, type Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { USDSUI_TYPE } from "@/lib/usdsui";

/**
 * Talise shielded-pool SDK — SERVER-SIDE DEPOSIT PTB builder (native bridge).
 *
 * The in-app private send is two legs with two different signers:
 *   • DEPOSIT  — the USER signs (it spends their own USDsui). zkLogin + Onara gas.
 *   • WITHDRAW — the relayer signs (severs the link). /api/shield/relay.
 *
 * The webview (`/app/shield-prove`) derives the user's NON-CUSTODIAL shield key,
 * proves the deposit in WASM (note secrets never leave the device), and POSTs the
 * proof + ECIES blobs here. This builder assembles the deposit `transact` PTB and
 * sources the exact-$amount deposit coin from the USER's own balance via
 * `coinWithBalance({ useGasCoin: false })` (same rail as sends / goal vaults), so
 * the coin sourcing happens server-side where the balance shape is known.
 *
 * Command shape mirrors `sdk/tx.ts::buildTransact` exactly:
 *   proof::new<Coin>(pool, points, root, public_value, n0, n1, c0, c1) -> Proof
 *   ext_data::new(value, value_sign=true, relayer=USER, fee=0, enc0, enc1) -> ExtData
 *   shielded_pool::transact<Coin>(pool, depositCoin, proof, ext) -> Coin   (zero return)
 *   TransferObjects([returnCoin] -> USER)
 *
 * On the deposit leg the on-chain `ext_data::assert_relayer(sender == relayer)`
 * requires `ext.relayer == sender`. The sender is the USER (zkLogin), so the
 * relayer field is set to the user's address. The proof binds pool / value /
 * nullifiers / commitments — NOT the relayer — so this is sound (verified by the
 * mainnet lifecycle harness). The `transact` return coin is a ZERO coin on a
 * deposit, transferred harmlessly back to the user.
 */

/** Deposit proof as produced by the in-page WASM prover (decimal strings + hex). */
export type ShieldDepositProof = {
  /** 128-byte compressed Groth16 proof points, hex (no 0x). */
  proofPointsHex: string;
  /** Targeted Merkle root (u256 decimal) — must be a known on-chain root. */
  root: string;
  /** Signed public value (deposit: == +amount), u256 decimal. */
  publicValue: string;
  inputNullifier0: string;
  inputNullifier1: string;
  outputCommitment0: string;
  outputCommitment1: string;
};

export type AppendShieldDepositParams = {
  /** A `Transaction` with the sender already set to the user. */
  tx: Transaction;
  packageId: string;
  poolObjectId: string;
  coinType?: string;
  /** Cleartext deposit value in micros — must equal the proof's public value. */
  amountMicros: bigint;
  /** The user's own Sui address — ext.relayer (== sender) AND the zero-coin sink. */
  userAddress: string;
  proof: ShieldDepositProof;
  /** ECIES note blobs for the two output notes (self-encrypted). */
  encryptedOutput0: Uint8Array;
  encryptedOutput1: Uint8Array;
};

function pointsFromHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (!/^[0-9a-f]+$/i.test(clean) || clean.length % 2 !== 0) {
    throw new Error("proofPointsHex must be even-length hex");
  }
  const pts = Uint8Array.from(clean.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
  if (pts.length !== 128) throw new Error(`proof points must be 128 bytes, got ${pts.length}`);
  return pts;
}

/**
 * Append the deposit `transact` calls onto `tx` (sender already set). Sources the
 * exact-$amount deposit coin from the user's USDsui balance. Throws on a malformed
 * proof — the build fails closed, no funds move.
 */
export function appendShieldDeposit(p: AppendShieldDepositParams): void {
  const { tx, packageId } = p;
  const coinType = p.coinType ?? USDSUI_TYPE;
  if (p.amountMicros <= 0n) throw new Error("deposit amount must be positive");
  const pts = pointsFromHex(p.proof.proofPointsHex);

  // proof::new<Coin>(pool, points, root, public_value, n0, n1, c0, c1) -> Proof
  const proofArg = tx.moveCall({
    target: `${packageId}::proof::new`,
    typeArguments: [coinType],
    arguments: [
      tx.pure.address(p.poolObjectId),
      tx.pure(bcs.vector(bcs.u8()).serialize(pts)),
      tx.pure(bcs.u256().serialize(BigInt(p.proof.root))),
      tx.pure(bcs.u256().serialize(BigInt(p.proof.publicValue))),
      tx.pure(bcs.u256().serialize(BigInt(p.proof.inputNullifier0))),
      tx.pure(bcs.u256().serialize(BigInt(p.proof.inputNullifier1))),
      tx.pure(bcs.u256().serialize(BigInt(p.proof.outputCommitment0))),
      tx.pure(bcs.u256().serialize(BigInt(p.proof.outputCommitment1))),
    ],
  });

  // ext_data::new(value, value_sign=true, relayer=USER, fee=0, enc0, enc1) -> ExtData
  const extArg = tx.moveCall({
    target: `${packageId}::ext_data::new`,
    arguments: [
      tx.pure(bcs.u64().serialize(p.amountMicros)),
      tx.pure(bcs.bool().serialize(true)), // deposit
      tx.pure.address(p.userAddress), // sender == relayer on the deposit leg
      tx.pure(bcs.u64().serialize(0n)),
      tx.pure(bcs.vector(bcs.u8()).serialize(p.encryptedOutput0)),
      tx.pure(bcs.vector(bcs.u8()).serialize(p.encryptedOutput1)),
    ],
  });

  // Exact-amount USDsui from the user's own coins — never the sponsor's gas coin.
  const depositCoin = tx.add(
    coinWithBalance({ type: coinType, balance: p.amountMicros, useGasCoin: false })
  );

  // shielded_pool::transact<Coin>(pool, depositCoin, proof, ext) -> Coin (zero)
  const out = tx.moveCall({
    target: `${packageId}::shielded_pool::transact`,
    typeArguments: [coinType],
    arguments: [tx.object(p.poolObjectId), depositCoin, proofArg, extArg],
  });

  // The transact return coin is ZERO on a deposit — transfer it back to the user.
  tx.transferObjects([out], tx.pure.address(p.userAddress));
}
