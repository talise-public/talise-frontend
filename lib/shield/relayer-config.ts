import "server-only";

/**
 * Talise shielded-pool RELAYER config, env-gated, dormant by default.
 *
 * The whole Workstream-C relayer + SDK surface is INERT unless `SHIELD_PKG`
 * is set. This mirrors `lib/yield/onchain.ts`'s env-gated pattern but is
 * deliberately FAIL-CLOSED: with no package id the validator + relay routes
 * 503, never falling back to a wildcard (an unconstrained relayer is a drain
 * hole, see PRIVACY-BUILD-PLAN.md Workstream C).
 *
 * NOTE: this module is intentionally named `relayer-config.ts` (not
 * `onchain.ts`) so it never collides with the indexer/merkle agent's
 * `lib/shield/onchain.ts`. If that file later lands with a `shieldConfigured()`
 * of its own, prefer it and delete this guard.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

/** The shielded-pool Move package id, pinned + normalized. `null` when unset. */
export function shieldPackageId(): string | null {
  const raw = process.env.SHIELD_PKG?.trim();
  if (!raw) return null;
  try {
    return normalizeSuiAddress(raw);
  } catch {
    return null;
  }
}

/** The Talise relayer's Sui address (ExtData.relayer + fee recipient). */
export function shieldRelayerAddress(): string | null {
  const raw = process.env.SHIELD_RELAYER_ADDRESS?.trim();
  if (!raw) return null;
  try {
    return normalizeSuiAddress(raw);
  } catch {
    return null;
  }
}

let _relayerKp: Ed25519Keypair | null = null;

/**
 * The relayer's signing keypair (`SHIELD_RELAYER_SK`). The relayer signs the
 * PTB as `sender` (the named `ExtData.relayer`) before Onara sponsors gas.
 * Throws when unset, callers gate on `shieldConfigured()` first. When both the
 * SK and the explicit `SHIELD_RELAYER_ADDRESS` are set, they MUST agree (the
 * address is what `validate-commands` pins `ExtData.relayer` against, and the
 * SK is what actually signs, a mismatch would let a tx pass validation but be
 * signed by a different sender).
 */
export function shieldRelayerKeypair(): Ed25519Keypair {
  if (_relayerKp) return _relayerKp;
  const sk = process.env.SHIELD_RELAYER_SK?.trim();
  if (!sk) {
    throw new Error(
      "SHIELD_RELAYER_SK missing, the relayer keypair that signs shielded transact PTBs"
    );
  }
  const kp = Ed25519Keypair.fromSecretKey(sk);
  const declared = shieldRelayerAddress();
  if (declared && normalizeSuiAddress(kp.toSuiAddress()) !== declared) {
    throw new Error(
      "SHIELD_RELAYER_SK address does not match SHIELD_RELAYER_ADDRESS"
    );
  }
  _relayerKp = kp;
  return _relayerKp;
}

/**
 * The shielded module name. Fixed; the package is the only env-tunable part.
 */
export const SHIELD_MODULE = "shielded_pool" as const;

/**
 * Max relayer fee (in CoinType base units, e.g. USDsui micros) the relayer
 * will accept inside an `ExtData`. A user-supplied fee above this is rejected
 * by `validate-commands`, it caps how much of the pool a single relayed tx
 * can route to the relayer, independent of the proof. Tunable via env; the
 * default (0.50 USDsui at 6 decimals) is a generous ceiling for a gas rebate.
 */
export function shieldMaxRelayerFee(): bigint {
  const raw = process.env.SHIELD_MAX_RELAYER_FEE?.trim();
  if (raw) {
    try {
      const v = BigInt(raw);
      if (v >= 0n) return v;
    } catch {
      /* fall through to default */
    }
  }
  return 500_000n;
}

/**
 * True only when BOTH the package id AND the relayer address are configured.
 * The relay route must 503 unless this holds, a relayer with no pinned
 * package or no own address cannot enforce its security invariants.
 */
export function shieldConfigured(): boolean {
  return shieldPackageId() !== null && shieldRelayerAddress() !== null;
}
