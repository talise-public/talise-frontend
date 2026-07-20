import "server-only";

/**
 * Shinami zkLogin REST wrappers, the path we use for mainnet.
 *
 * Why Shinami: Mysten's hosted mainnet prover whitelists OAuth audiences and
 * ours isn't on it. Shinami runs an open zkLogin Wallet service + zkProver
 * service: register an account, paste the API key, mainnet works.
 *
 * Two endpoints we call:
 *   - shinami_zkw_getOrCreateZkLoginWallet(jwt) → { address, salt }
 *     Shinami manages the salt deterministically per (iss, sub). Same JWT
 *     always yields the same address.
 *   - shinami_zkp_createZkLoginProof(jwt, maxEpoch, extEphPubKey, randomness,
 *     salt) → { zkProof: { proofPoints, issBase64Details, headerBase64 } }
 *
 * Docs: https://docs.shinami.com/api-docs/sui/wallet-services/zklogin-wallet-api
 */

const WALLET_URL = "https://api.us1.shinami.com/sui/zkwallet/v1";
const PROVER_URL = "https://api.us1.shinami.com/sui/zkprover/v1";
/**
 * Shinami's paid Sui-node JSON-RPC endpoint. Same host family as the
 * gRPC node URL in `lib/sui-endpoints.ts`, different path (`/sui/node/v1`
 * speaks BOTH gRPC-Web and JSON-RPC, Shinami picks the protocol from
 * the `Content-Type` and the body shape). Auth header is `X-Api-Key`,
 * matching the gRPC fallback chain.
 */
const NODE_JSON_RPC_URL = "https://api.us1.shinami.com/sui/node/v1";
const NODE_AUTH_HEADER = "X-Api-Key";

function apiKey(): string {
  const k = process.env.SHINAMI_API_KEY;
  if (!k) {
    throw new Error(
      "SHINAMI_API_KEY missing. Get one at https://app.shinami.com and paste into .env.local."
    );
  }
  return k;
}

export function shinamiEnabled(): boolean {
  return !!process.env.SHINAMI_API_KEY;
}

/**
 * Resolve Shinami's paid Sui-node JSON-RPC endpoint + auth header pair.
 *
 * Returns `null` when no node-service key is configured so callers can
 * cleanly fall back to the public `fullnode.mainnet.sui.io:443` URL
 * without a try/catch. Does NOT throw, that contract matters because
 * the gasless build path treats a missing Shinami config as "use
 * public" and a present-but-invalid key as a hard fail (caught by the
 * retry guard).
 *
 * IMPORTANT: Shinami's Node Service uses a DIFFERENT API key from the
 * zkLogin Wallet + zkProver services (verified 2026-05-30, the same
 * SHINAMI_API_KEY that works on `/sui/zkprover/v1` and
 * `/sui/zkwallet/v1` returns 401 on `/sui/node/v1`). Provision a
 * separate Node Service key at https://app.shinami.com and set it as
 * `SHINAMI_NODE_API_KEY`. If only the legacy `SHINAMI_API_KEY` is
 * present (no node-service key), this returns `null` and the gasless
 * build path stays on public mainnet, no retry-on-401 overhead.
 */
export function shinamiSuiNodeJsonRpc():
  | { url: string; headers: Record<string, string> }
  | null {
  const key = process.env.SHINAMI_NODE_API_KEY;
  if (!key || key.trim().length === 0) return null;
  return {
    url: NODE_JSON_RPC_URL,
    headers: { [NODE_AUTH_HEADER]: key },
  };
}

/** Decode Shinami's base64 salt into a decimal-string BigInt (what genAddressSeed wants). */
function decodeSalt(salt: string): string {
  // Shinami returns salt as base64 over JSON-RPC. Convert to BigInt-as-decimal.
  // If it already looks numeric (Shinami sometimes returns decimal), pass through.
  if (/^\d+$/.test(salt)) return salt;
  const bytes = Buffer.from(salt, "base64");
  return BigInt("0x" + bytes.toString("hex")).toString();
}

type RpcResp<T> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string } };

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey(),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`shinami ${method} ${r.status}: ${text.slice(0, 240)}`);
  }
  const j = (await r.json()) as RpcResp<T>;
  if ("error" in j) {
    throw new Error(`shinami ${method}: ${j.error.message} (${j.error.code})`);
  }
  return j.result;
}

type ShinamiWallet = {
  userId: { iss: string; aud: string; keyClaimName: string; keyClaimValue: string };
  subWallet: number;
  salt: string; // base64 or decimal
  address: string;
};

/** Resolve the user's Sui address + Shinami-managed salt for this JWT. */
export async function shinamiGetWallet(jwt: string): Promise<{ address: string; salt: string }> {
  const w = await rpc<ShinamiWallet>(WALLET_URL, "shinami_zkw_getOrCreateZkLoginWallet", [jwt]);
  return { address: w.address, salt: decodeSalt(w.salt) };
}

export type ShinamiProof = {
  proofPoints: { a: string[]; b: string[][]; c: string[] };
  issBase64Details: { value: string; indexMod4: number };
  headerBase64: string;
};

/**
 * Mint a zkLogin proof via Shinami. Drop-in replacement for the Mysten prover.
 *
 * Rate limit: 2 proofs per address per minute (error -32012 if exceeded).
 */
export async function shinamiCreateProof(opts: {
  jwt: string;
  maxEpoch: number;
  /** Decimal string, the extended ephemeral pub key per @mysten/sui zklogin. */
  extendedEphemeralPublicKey: string;
  /** Decimal string from generateRandomness(). */
  jwtRandomness: string;
  /** Decimal-string salt (already in BigInt form via decodeSalt or local). */
  salt: string;
}): Promise<ShinamiProof> {
  const wrapped = await rpc<{ zkProof: ShinamiProof }>(
    PROVER_URL,
    "shinami_zkp_createZkLoginProof",
    [
      opts.jwt,
      String(opts.maxEpoch),
      opts.extendedEphemeralPublicKey,
      opts.jwtRandomness,
      opts.salt,
      "sub",
    ]
  );
  return wrapped.zkProof;
}
