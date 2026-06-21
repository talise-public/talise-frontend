import { suiGrpcWithFallback } from "./sui-endpoints";
import { memoTtl } from "./perf-cache";

/**
 * Shared epoch helper. Talise reads the live Sui mainnet epoch in exactly
 * two places — `/api/sui/epoch` (the iOS client polls this before generating
 * its ephemeral key) and `/api/auth/mobile/start` (computes `maxEpoch` for
 * the zkLogin nonce). Both want the same value within the same second.
 *
 * gRPC has NO direct equivalent of JSON-RPC's `getLatestSuiSystemState`
 * (Pattern 10 in docs/sui-rpc-migration/patterns.md). The closest one-shot
 * read is `LedgerService.getServiceInfo`, which returns the current
 * `epoch` (uint64) along with chain id, server version, and the most-recent
 * checkpoint height. We pull the `epoch` field and ignore the rest.
 *
 * Cached for 30 seconds — epochs flip every ~24h on mainnet, so a 30-second
 * window is well inside an epoch and avoids hammering the fullnode when
 * many sign-ins land within the same minute.
 */

const EPOCH_TTL_MS = 30_000;
const MAX_EPOCH_HORIZON = 2;

/**
 * Current Sui mainnet epoch as a JS number.
 *
 * Shape note: gRPC's `GetServiceInfoResponse.epoch` is a `bigint` (proto
 * uint64). JSON-RPC's `state.epoch` was a stringified integer. We coerce
 * to `number` here because the only consumers stringify it for transport
 * (`/api/sui/epoch` returns `{ epoch: String }`) or add the small horizon
 * constant (`maxEpoch = epoch + 2`) and both fit comfortably in a JS
 * number for the foreseeable future (current mainnet epoch is ~700; JS
 * safe-integer ceiling is 2^53). If/when Sui crosses 2^53 epochs we have
 * bigger problems.
 */
export async function getCurrentEpoch(): Promise<number> {
  return memoTtl("sui:current-epoch", EPOCH_TTL_MS, async () => {
    // Multi-endpoint fallback — try Mysten's fullnode first, then
    // archival, then any configured paid providers (Shinami, Dwellir,
    // QuickNode). Catches today's Mysten outage shape
    // (`no_healthy_upstream` / 503 / `UNAVAILABLE`) and walks the chain.
    const res = await suiGrpcWithFallback(async (client) => {
      // `getServiceInfo` returns a UnaryCall which is thenable —
      // await it to resolve, then the `.response` field holds the
      // typed body. Wrapping in `async` keeps TS happy about the
      // Promise<T> contract.
      return await client.ledgerService.getServiceInfo({});
    });
    const epoch = res.response?.epoch;
    if (epoch == null) {
      throw new Error("ledgerService.getServiceInfo returned no epoch");
    }
    const n = Number(epoch);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`ledgerService.getServiceInfo returned invalid epoch: ${epoch}`);
    }
    return n;
  });
}

/**
 * Max epoch for a freshly minted zkLogin ephemeral key: current + 2.
 * Mirrors the constant the iOS client uses; centralised here so the
 * server-side nonce binder and the client-side ephemeral generator
 * always agree on the horizon.
 */
export async function getMaxEpoch(): Promise<number> {
  return (await getCurrentEpoch()) + MAX_EPOCH_HORIZON;
}

// Chain identifier is the base58 genesis-checkpoint digest — IMMUTABLE per
// network. The gasless `ValidDuring` expiration must carry it as `chain`.
// Cached for 6h (effectively forever; the re-fetch only guards against a
// pathological process that outlives a network swap) and read through the
// same multi-endpoint fallback as the epoch so a single-fullnode outage
// doesn't break the send build.
const CHAIN_ID_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Current Sui network's chain identifier (base58 genesis digest).
 *
 * Used by the gasless send build to set `ValidDuring.chain`. Reads via the
 * unified `core.getChainIdentifier()` (resolves directly to
 * `{ chainIdentifier }`, unlike the `ledgerService.getServiceInfo` UnaryCall)
 * wrapped in `suiGrpcWithFallback` so it walks past an unhealthy primary.
 */
export async function getChainIdentifier(): Promise<string> {
  return memoTtl("sui:chain-identifier", CHAIN_ID_TTL_MS, async () => {
    const res = await suiGrpcWithFallback(async (client) =>
      client.core.getChainIdentifier()
    );
    const id = (res as { chainIdentifier?: string } | null)?.chainIdentifier;
    if (!id) {
      throw new Error("core.getChainIdentifier returned no chainIdentifier");
    }
    return id;
  });
}
