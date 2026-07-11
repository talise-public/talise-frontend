import "server-only";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromBase64 } from "@mysten/sui/utils";
import { sui, USDSUI_DECIMALS } from "./sui";
import { USDSUI_TYPE } from "./usdsui";
import { getChainIdentifier, getCurrentEpoch } from "./sui-epoch";
import { assembleZkLoginSignature } from "./zksigner";
import type { AgentWalletRow } from "./agent-wallets";

/**
 * Server-side gasless USDsui send for a custodial agent wallet.
 *
 * This is the server half of what the CLI/app normally do on-device: build the
 * gasless `0x2::balance::send_funds` PTB, sign the bytes with the wallet's
 * CUSTODIED ephemeral key, assemble the zkLogin signature from the wallet's
 * JWT+salt, and broadcast directly to the fullnode (gasless needs only the
 * user's zkLogin signature — no sponsor). The build mirrors
 * `/api/send/sponsor-prepare`'s gasless branch byte-for-byte (ValidDuring
 * expiration + empty gas payment) so it produces the same accumulator-only PTB.
 *
 * Caller is responsible for auth, cap reservation, screening, and limits.
 */
export async function agentGaslessSend(opts: {
  wallet: AgentWalletRow;
  toAddress: string; // 0x…, already resolved + screened by the caller
  amountUsd: number;
}): Promise<{ digest: string }> {
  const { wallet, toAddress, amountUsd } = opts;
  const client = sui();

  const onchain = BigInt(Math.round(amountUsd * 10 ** USDSUI_DECIMALS));
  if (onchain <= 0n) throw new Error("amount too small");

  const tx = new Transaction();
  tx.setSender(wallet.suiAddress);
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [USDSUI_TYPE],
    arguments: [tx.balance({ type: USDSUI_TYPE, balance: onchain }), tx.pure.address(toAddress)],
  });
  // Gasless: price AND budget must both be explicitly 0.
  tx.setGasPrice(0n);
  tx.setGasBudget(0n);

  // ValidDuring escape hatch (the accumulator-only PTB has no address-owned
  // input): valid for current + next epoch, the max the gasless rail allows.
  const [chainId, currentEpoch] = await Promise.all([getChainIdentifier(), getCurrentEpoch()]);
  const epochBig = BigInt(currentEpoch);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String(epochBig),
      maxEpoch: String(epochBig + 1n),
      minTimestamp: null,
      maxTimestamp: null,
      chain: chainId,
      nonce: (Math.random() * 4294967296) >>> 0,
    },
  });
  // Load-bearing: empty gas payment flips the SDK to an offline BCS build.
  tx.setGasPayment([]);

  const bytes = await tx.build({ client: client as never });

  // Sign the bytes with the wallet's custodied ephemeral key (the custodial
  // part). signTransaction applies the Sui intent prefix + Blake2b-256.
  const kp = Ed25519Keypair.fromSecretKey(fromBase64(wallet.ephemeralSkB64));
  const { signature: userSignature } = await kp.signTransaction(bytes);

  // Assemble the full zkLogin signature (proof minted from the wallet's JWT+salt).
  const assembled = await assembleZkLoginSignature({
    ephemeralPubKeyB64: wallet.ephemeralPubKeyB64,
    maxEpoch: wallet.maxEpoch,
    randomness: wallet.randomness,
    userSignature,
    jwt: wallet.jwt,
    salt: wallet.salt,
  });

  const result = (await client.executeTransaction({
    transaction: bytes,
    signatures: [assembled.signature],
  })) as Record<string, unknown>;

  // MONEY-SAFETY: a Move-ABORT returns FailedTransaction WITH a digest — never
  // report it as a delivered send (no funds moved).
  const okTx = result.Transaction as { digest?: string } | undefined;
  const failedTx = result.FailedTransaction as { digest?: string } | undefined;
  if ((result.$kind as string | undefined) === "FailedTransaction" || (failedTx && !okTx)) {
    throw new Error("transaction failed on chain (aborted), funds not moved");
  }
  const digest = (result.digest as string | undefined) ?? okTx?.digest ?? "";
  if (!digest) throw new Error("no digest in broadcast response");
  return { digest };
}
