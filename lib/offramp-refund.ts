import "server-only";

import { randomBytes } from "node:crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { sui, USDSUI_DECIMALS } from "@/lib/sui";
import { USDSUI_TYPE } from "@/lib/usdsui";
import { getChainIdentifier, getCurrentEpoch } from "@/lib/sui-epoch";

/**
 * Treasury USDsui send helper.
 *
 * The Linq off-ramp owns deposit detection, the payout timeout, and any
 * failure handling itself (the user sends USDSUI to Linq's deposit wallet and
 * Linq pays the bank), so Talise no longer runs an off-ramp refund path. What
 * remains here is the reusable gasless treasury send — `treasurySendUsdsui` —
 * used by the admin tester-seed path (closed-alpha money-in) to credit invited
 * testers a small balance to transact with.
 *
 * Custody: the treasury is controlled by `OFFRAMP_TREASURY_SK` (an Ed25519
 * secret key whose address MUST equal `TALISE_OFFRAMP_TREASURY`).
 */

let _treasury: Ed25519Keypair | null = null;

export function offrampRefundEnabled(): boolean {
  return !!process.env.OFFRAMP_TREASURY_SK;
}

function treasuryKeypair(): Ed25519Keypair {
  if (_treasury) return _treasury;
  const k = process.env.OFFRAMP_TREASURY_SK;
  if (!k) throw new Error("OFFRAMP_TREASURY_SK missing — the off-ramp treasury key");
  _treasury = Ed25519Keypair.fromSecretKey(k);
  return _treasury;
}

function usdToMicros(usd: number): bigint {
  return BigInt(Math.round(usd * 10 ** USDSUI_DECIMALS));
}

/**
 * Pay USDsui out of the treasury to `toAddress`, signed by the treasury key.
 * Mirrors lib/cheques.ts `escrowTransfer` (gasless send_funds accumulator
 * recipe — gasPrice/budget 0, ValidDuring, empty gas payment). Returns the
 * on-chain digest.
 */
async function treasuryTransfer(toAddress: string, micros: bigint): Promise<string> {
  const kp = treasuryKeypair();
  const sender = kp.getPublicKey().toSuiAddress();
  const expected = (process.env.TALISE_OFFRAMP_TREASURY ?? "").toLowerCase();
  if (expected && sender.toLowerCase() !== expected) {
    throw new Error(
      `OFFRAMP_TREASURY_SK address ${sender} != TALISE_OFFRAMP_TREASURY ${expected}`
    );
  }
  const tx = new Transaction();
  tx.setSender(sender);
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [USDSUI_TYPE],
    arguments: [tx.balance({ type: USDSUI_TYPE, balance: micros }), tx.pure.address(toAddress)],
  });
  tx.setGasPrice(0n);
  tx.setGasBudget(0n);
  const [chainId, currentEpoch] = await Promise.all([getChainIdentifier(), getCurrentEpoch()]);
  const epoch = BigInt(currentEpoch);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String(epoch),
      maxEpoch: String(epoch + 1n),
      minTimestamp: null,
      maxTimestamp: null,
      chain: chainId,
      nonce: randomBytes(4).readUInt32BE(0),
    },
  });
  tx.setGasPayment([]);
  const client = sui();
  const bytes = await tx.build({ client: client as never });
  const { signature } = await kp.signTransaction(bytes);
  const result = (await client.executeTransaction({
    transaction: fromBase64(Buffer.from(bytes).toString("base64")),
    signatures: [signature],
  })) as Record<string, unknown>;
  const inner =
    (result.Transaction as { digest?: string } | undefined) ??
    (result.FailedTransaction as { digest?: string } | undefined);
  const digest = (result.digest as string | undefined) ?? inner?.digest;
  if (!digest) throw new Error("treasury refund produced no digest");
  if ((result.$kind as string | undefined) === "FailedTransaction") {
    throw new Error("treasury refund failed on chain");
  }
  return digest;
}

/**
 * Pay USDsui out of the treasury to any address — the reusable form of
 * `treasuryTransfer`. Used by the admin tester-seed path (closed-alpha
 * money-in) to credit invited testers a small balance to transact with.
 * Returns the on-chain digest. Requires `OFFRAMP_TREASURY_SK` (the same
 * treasury that funds refunds) to be configured + hold USDsui.
 */
export async function treasurySendUsdsui(
  toAddress: string,
  usd: number
): Promise<string> {
  return treasuryTransfer(toAddress, usdToMicros(usd));
}
