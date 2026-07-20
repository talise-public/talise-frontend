import "server-only";

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuinsClient, SuinsTransaction } from "@mysten/suins";
import { sui } from "./sui";

/**
 * SuiNS operator, server-side helper that owns the `talise.sui` parent name
 * and mints `name.talise.sui` subname NFTs for users on claim.
 *
 * Flow per claim:
 *   1. User taps "Claim sele" at /claim.
 *   2. Server validates input + writes the username row (race-safe via UNIQUE).
 *   3. Server calls `mintSubname({ username, userAddress })`:
 *      - Builds a `SuinsTransaction.createSubName(...)` PTB
 *      - Transfers the resulting NFT to the user's Sui address
 *      - Signs with the operator key (pays its own gas)
 *      - Submits to mainnet
 *   4. The user's wallet now contains `sele.talise.sui` as a transferable
 *      NFT, and every SuiNS resolver (suivision, suiscan, every wallet)
 *      sees it.
 *
 * If the on-chain mint fails, the claim route rolls back the DB row so DB
 * state stays consistent with chain state.
 */

const PACKAGE_NETWORK = "mainnet" as const;

let _operator: Ed25519Keypair | null = null;
let _suins: SuinsClient | null = null;

function operator(): Ed25519Keypair {
  if (_operator) return _operator;
  const k = process.env.TALISE_SUINS_OPERATOR_KEY;
  if (!k) {
    throw new Error(
      "TALISE_SUINS_OPERATOR_KEY missing, the operator wallet that holds talise.sui"
    );
  }
  _operator = Ed25519Keypair.fromSecretKey(k);
  return _operator;
}

/**
 * A DIRECT-fullnode gRPC client for the subname mint, NOT the Hayabusa-proxied
 * `sui()`. `tx.build()` resolves its inputs (the parent SuinsRegistration NFT,
 * the shared SuiNS registry objects) by reading them back from the client; the
 * Hayabusa read/cache proxy returns "Not Found" for those owned/shared object
 * lookups, which surfaced to users as `On-chain subname mint failed: Not Found`.
 * The direct fullnode resolves them correctly (build + simulate verified green).
 * Mirrors `chequeChainClient()` in lib/cheques.ts, which fixed the same class of
 * bug for the on-chain cheque build. Execution still goes through `sui()` (its
 * broadcast path already bypasses Hayabusa and keeps the multi-endpoint failover).
 */
function directChainClient(): SuiGrpcClient {
  return new SuiGrpcClient({
    network: PACKAGE_NETWORK,
    baseUrl: process.env.SUI_GRPC_URL?.trim() || "https://fullnode.mainnet.sui.io:443",
  });
}

export function suins(): SuinsClient {
  if (_suins) return _suins;
  // Build the SuinsTransaction against the DIRECT fullnode, not the
  // Hayabusa-proxied `sui()`, object resolution during `tx.build()` 404s
  // through the read proxy. See directChainClient() above.
  _suins = new SuinsClient({
    client: directChainClient() as never,
    network: PACKAGE_NETWORK,
  });
  return _suins;
}

export function suinsOperatorEnabled(): boolean {
  return (
    !!process.env.TALISE_SUINS_OPERATOR_KEY &&
    !!process.env.TALISE_SUI_NFT_ID &&
    !!process.env.TALISE_SUI_EXPIRY_MS
  );
}

export function suinsOperatorAddress(): string {
  return operator().getPublicKey().toSuiAddress();
}

// ── Low-balance gas guard ────────────────────────────────────────────────────
//
// Each subname mint costs the operator ~0.0078 SUI in gas. When the operator
// wallet runs dry, the mint tx fails on-chain, and the claim routes roll the
// reservation back and surface a scary "mint failed" 502, exactly the incident
// where a batch of users couldn't claim their names. This guard runs a cheap
// balance read BEFORE we build/broadcast, so we can fail FAST and GRACEFULLY:
// the routes keep the reservation and return a calm "reserved, finalizing
// shortly" instead of losing the name. A WARN tier also logs early so the
// operator gets topped up before claims ever pause.

/** Below this (≈2-3 mints of runway) we stop minting and reserve+retry. */
export const OPERATOR_GAS_BLOCK_SUI = 0.02;
/** Below this (≈6 mints) we still mint but log a loud top-up alert. */
export const OPERATOR_GAS_WARN_SUI = 0.05;

/** Thrown by `assertOperatorGas()` when the operator can't safely fund a mint. */
export class LowOperatorGasError extends Error {
  readonly code = "LOW_OPERATOR_GAS" as const;
  readonly sui: number;
  constructor(sui: number) {
    super(
      `operator gas too low to mint: ${sui.toFixed(4)} SUI < ${OPERATOR_GAS_BLOCK_SUI} SUI threshold`
    );
    this.name = "LowOperatorGasError";
    this.sui = sui;
  }
}

/**
 * Pre-mint gas check. Logs a loud alert in the WARN band (top up soon) and
 * throws `LowOperatorGasError` in the BLOCK band (can't safely mint). Cheap -
 * one `getBalance` read. Never throws on a balance-read failure (fails open so
 * a transient RPC blip doesn't block a mint the wallet could actually afford).
 */
export async function assertOperatorGas(): Promise<void> {
  const addr = suinsOperatorAddress();
  let suiBal: number;
  try {
    // Read the balance DIRECTLY, not via getSuiBalance(), which swallows RPC
    // errors and returns 0. A swallowed 0 would look like an empty wallet and
    // wrongly BLOCK a mint on a transient blip. A genuine RPC failure here
    // throws and we fail OPEN: never block a mint the wallet could afford.
    const res = await sui().getBalance({ owner: addr });
    suiBal = Number(BigInt(res.balance.balance)) / 1e9;
  } catch {
    return; // fail open
  }
  if (suiBal < OPERATOR_GAS_BLOCK_SUI) {
    console.error(
      `[ALERT][operator-gas] BLOCKING mints, ${suiBal.toFixed(4)} SUI on ${addr} (< ${OPERATOR_GAS_BLOCK_SUI}). TOP UP NOW; claims are being reserved + queued.`
    );
    throw new LowOperatorGasError(suiBal);
  }
  if (suiBal < OPERATOR_GAS_WARN_SUI) {
    console.warn(
      `[ALERT][operator-gas] LOW, ${suiBal.toFixed(4)} SUI on ${addr} (< ${OPERATOR_GAS_WARN_SUI}, ~${Math.floor(suiBal / 0.0078)} mints left). Top up soon.`
    );
  }
}

/**
 * Mint `<username>.talise.sui` as a transferable NFT and send it to
 * `userAddress`. Returns the tx digest + the new subname NFT object id.
 *
 * Bare username (e.g. "sele"), no `.talise.sui` suffix, the SuiNS SDK
 * appends the parent's labels under the hood.
 */
export async function mintSubname(opts: {
  username: string;
  userAddress: string;
}): Promise<{ digest: string; subnameNftId: string | null }> {
  const parentNftId = process.env.TALISE_SUI_NFT_ID;
  const parentExpiryMs = Number(process.env.TALISE_SUI_EXPIRY_MS);
  if (!parentNftId) throw new Error("TALISE_SUI_NFT_ID missing");
  if (!Number.isFinite(parentExpiryMs) || parentExpiryMs <= Date.now()) {
    throw new Error(
      `TALISE_SUI_EXPIRY_MS invalid or expired (got ${process.env.TALISE_SUI_EXPIRY_MS})`
    );
  }

  // Fail fast + graceful if the operator can't fund the mint, the routes
  // catch LowOperatorGasError, keep the reservation, and tell the user it's
  // "reserved, finalizing shortly" rather than rolling back with a 502.
  await assertOperatorGas();

  const tx = new Transaction();
  const suinsTx = new SuinsTransaction(suins(), tx);

  const nft = suinsTx.createSubName({
    parentNft: parentNftId,
    name: `${opts.username}.talise.sui`,
    expirationTimestampMs: parentExpiryMs,
    allowChildCreation: false,
    allowTimeExtension: false,
  });

  // Bind the subname to the user's address so `getNameRecord` resolves.
  // Without this, the SuiNS dynamic field exists but `targetAddress` is
  // null, the name is "taken" but resolves to nothing. The operator can
  // sign for this call while it still holds the NFT (before the transfer
  // below in the same PTB).
  suinsTx.setTargetAddress({
    nft,
    address: opts.userAddress,
    isSubname: true,
  });

  tx.transferObjects([nft], opts.userAddress);

  const kp = operator();
  tx.setSender(kp.getPublicKey().toSuiAddress());

  // Build (resolve inputs) against the DIRECT fullnode, the Hayabusa read
  // proxy 404s the parent NFT / SuiNS object lookups ("…mint failed: Not Found").
  const bytes = await tx.build({ client: directChainClient() as never });
  const { signature } = await kp.signTransaction(bytes);

  // Execute through `sui()`, its broadcast path bypasses Hayabusa and keeps
  // the multi-endpoint failover for the actual on-chain submit.
  const client = sui();

  // gRPC executeTransaction returns a discriminated union:
  //   { $kind: "Transaction",       Transaction:       { digest, effects, objectTypes, ... } }
  //   { $kind: "FailedTransaction", FailedTransaction: { digest, effects, ... } }
  // We request `effects` to check status and `objectTypes` so we can
  // identify the freshly-minted SubDomainRegistration without a follow-up
  // round trip (effects.changedObjects carries the ids; objectTypes maps
  // id → fully-qualified Move type).
  const result = (await client.executeTransaction({
    transaction: bytes,
    signatures: [signature],
    include: { effects: true, objectTypes: true },
  })) as Record<string, unknown>;

  if ((result.$kind as string | undefined) === "FailedTransaction") {
    const failed = result.FailedTransaction as
      | { effects?: { status?: { error?: unknown } } }
      | undefined;
    const err = failed?.effects?.status?.error;
    const reason =
      (typeof err === "string" && err) ||
      (typeof err === "object" &&
        err !== null &&
        "message" in err &&
        (err as { message?: string }).message) ||
      "unknown failure";
    throw new Error(`subname mint failed: ${reason}`);
  }

  const txInner = result.Transaction as
    | {
        digest?: string;
        effects?: {
          status?: { success?: boolean; error?: unknown };
          changedObjects?: Array<{
            objectId: string;
            idOperation: "Unknown" | "None" | "Created" | "Deleted";
          }>;
        };
        objectTypes?: Record<string, string>;
      }
    | undefined;

  if (txInner?.effects?.status && txInner.effects.status.success === false) {
    const err = txInner.effects.status.error;
    const reason =
      (typeof err === "string" && err) ||
      (typeof err === "object" &&
        err !== null &&
        "message" in err &&
        (err as { message?: string }).message) ||
      "unknown failure";
    throw new Error(`subname mint failed: ${reason}`);
  }

  // The created NFT is the SubDomainRegistration / SuinsRegistration object
  // owned by the user. Walk `effects.changedObjects` for objects whose
  // idOperation === "Created" and check the type via `objectTypes`.
  let subnameNftId: string | null = null;
  const changed = txInner?.effects?.changedObjects ?? [];
  const types = txInner?.objectTypes ?? {};
  for (const ch of changed) {
    if (ch.idOperation !== "Created" || !ch.objectId) continue;
    const ty = types[ch.objectId] ?? "";
    if (/SubDomainRegistration|SuinsRegistration/.test(ty)) {
      subnameNftId = ch.objectId;
      break;
    }
  }

  return { digest: txInner?.digest ?? "", subnameNftId };
}
