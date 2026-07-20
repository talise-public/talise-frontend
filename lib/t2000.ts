/**
 * Thin server-side wrapper around the @t2000/sdk agentic-finance layer.
 *
 * The SDK wraps NAVI lending (save/borrow/withdraw/repay) and the Cetus DEX
 * aggregator (swap) behind a clean, agent-friendly TypeScript API. We use it
 * instead of hand-rolling DeepBook integration for the save/swap/borrow
 * primitives.
 *
 * Public surface:
 *   - `getT2000(opts)` returns a configured `T2000` instance bound to the
 *     caller's user (via their zkLogin ephemeral key + proof). The signer is
 *     constructed inside the SDK via `T2000.fromZkLogin()`, we never hold
 *     long-lived keys here.
 *   - `getT2000FromSigner(signer)` is the typed escape hatch for callers who
 *     already have a `TransactionSigner` (e.g. a hot-wallet adapter for
 *     server-side flows). It delegates to the same `fromZkLogin` factory by
 *     accepting the proof bundle, since the SDK does not expose a public
 *     constructor for arbitrary `TransactionSigner` instances yet.
 *
 * Network is read from `NEXT_PUBLIC_SUI_NETWORK` (defaults to "testnet"). The
 * SDK initializes its own SuiJsonRpcClient internally based on the rpcUrl we
 * pass (derived from network).
 *
 * This module is server-only, the SDK's main entry pulls in Node-only
 * dependencies (eventemitter3 + Cetus aggregator SDK) that don't tree-shake
 * cleanly for the browser bundle.
 */
import "server-only";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import {
  T2000,
  type TransactionSigner,
  type ZkLoginProof,
} from "@t2000/sdk";

type SuiNetwork = "mainnet" | "testnet";

function resolveNetwork(): SuiNetwork {
  const raw = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet").toLowerCase();
  return raw === "mainnet" ? "mainnet" : "testnet";
}

function resolveRpcUrl(): string {
  const explicit = process.env.SUI_RPC_URL;
  if (explicit && explicit.length > 0) return explicit;
  return getJsonRpcFullnodeUrl(resolveNetwork());
}

/**
 * Build a T2000 client bound to the caller's zkLogin identity.
 *
 * The SDK constructs the `ZkLoginSigner` internally from the proof bundle -
 * we never serialize or persist the ephemeral key. This is the documented
 * signer-based factory for the published SDK (v2.11.0).
 */
export function getT2000(opts: {
  ephemeralKeypair: Ed25519Keypair;
  zkProof: ZkLoginProof;
  userAddress: string;
  maxEpoch: number;
}): T2000 {
  return T2000.fromZkLogin({
    ephemeralKeypair: opts.ephemeralKeypair,
    zkProof: opts.zkProof,
    userAddress: opts.userAddress,
    maxEpoch: opts.maxEpoch,
    rpcUrl: resolveRpcUrl(),
  });
}

/**
 * Type re-export so callers can type their signer references without
 * depending on `@t2000/sdk` directly.
 */
export type { TransactionSigner, ZkLoginProof };
