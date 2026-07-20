import { SuiGrpcClient } from "@mysten/sui/grpc";
import { USDSUI_TYPE } from "./usdsui";
import {
  MAINNET_GRPC_ENDPOINTS,
  buildClientForEndpoint,
  suiGrpcWithFallback,
  suiGrpcBroadcast,
} from "./sui-endpoints";

export type Network = "testnet" | "mainnet";

/**
 * Re-export USDSUI_TYPE so callers can grab the coin type from the same
 * module they grab balance/network helpers from.
 */
export { USDSUI_TYPE };

/**
 * USDsui native decimals. The on-chain metadata reports 6 (verified against
 * `suix_getCoinMetadata` for `0x44f838…::usdsui::USDSUI`). Keep in sync if
 * the registry ever changes.
 * TODO: verify against `suix_getCoinMetadata` at runtime if/when the deploy
 * changes, defaulting to 6 to match every other Sui-native USD stable.
 */
export const USDSUI_DECIMALS = 6;

export function network(): Network {
  const v = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? "mainnet").toLowerCase();
  return v === "testnet" ? "testnet" : "mainnet";
}

/**
 * Default gRPC endpoint for Sui mainnet. The same fullnode host serves both
 * JSON-RPC and gRPC-web (port 443, no special path). Mirrors the value
 * Onara wires through `SUI_GRPC_URL`.
 */
function defaultGrpcBaseUrl(net: Network): string {
  // env override lets us point at a private gRPC endpoint (Shinami, etc.)
  // without touching code. Falls back to the public fullnode.
  const fromEnv = process.env.SUI_GRPC_URL ?? process.env.NEXT_PUBLIC_SUI_GRPC_URL;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  return net === "mainnet"
    ? "https://fullnode.mainnet.sui.io:443"
    : "https://fullnode.testnet.sui.io:443";
}

// ─── gRPC (default) ───────────────────────────────────────────────────────────
// `sui()` returns a Proxy-wrapped `SuiGrpcClient` that transparently routes
// every method call through `suiGrpcWithFallback` (lib/sui-endpoints.ts). The
// fallback chain tries Mysten primary → Mysten archival → Shinami → Dwellir
// → QuickNode in order, walking past any endpoint that returns
// UNAVAILABLE / DEADLINE_EXCEEDED / 5xx. On the happy path (Mysten healthy)
// it's a single network call, the fallback only kicks in on failure.
//
// This replaces the prior single-endpoint singleton + the `SUI_GRPC_URL`
// env-override band-aid we shipped during the 2026-05-28 Mysten outage.
// Callers don't change: `sui().getBalance(...)`, `sui().ledgerService.getEpoch(...)`,
// `tx.build({ client: sui() })`, all still work because the proxy
// preserves the shape of the underlying client.

let _grpc: SuiGrpcClient | null = null;

/**
 * Whitelist of top-level RPC method names on `SuiGrpcClient` that should be
 * routed through the fallback chain. Any other property access (including
 * SDK-internal hooks like `resolveTransactionPlugin`, `transport`, `network`,
 * etc.) passes through to the underlying client UNMODIFIED, wrapping those
 * breaks the SDK's `client?.X ?? defaultX` fallback patterns (which is what
 * `tx.build()` uses to look up `resolveTransactionPlugin`).
 */
const TOP_LEVEL_RPC_METHODS = new Set<string>([
  "getBalance",
  "getCoinMetadata",
  "getObject",
  "getObjects",
  "listOwnedObjects",
  "listCoins",
  "listBalances",
  "listDynamicFields",
  "getDynamicField",
  "getTransaction",
  "simulateTransaction",
  "executeTransaction",
  "waitForTransaction",
  "signAndExecuteTransaction",
  "getReferenceGasPrice",
]);

/**
 * The subset of RPC methods that must BYPASS the Hayabusa read/cache proxy and
 * go straight to a direct fullnode: writes (`executeTransaction`,
 * `signAndExecuteTransaction`) and the non-cacheable, state-dependent dry-run
 * (`simulateTransaction`). Hayabusa forbids writes (PERMISSION_DENIED) and 502s
 * on simulate, and neither error is fallback-eligible, so without this they'd
 * die on Hayabusa and never reach the fullnode behind it (the Save-OFF gasless
 * send bug). Routed through `suiGrpcBroadcast`; everything else keeps the
 * Hayabusa-first read chain. See lib/sui-endpoints.ts:suiGrpcBroadcast.
 */
const BROADCAST_METHODS = new Set<string>([
  "executeTransaction",
  "signAndExecuteTransaction",
  "simulateTransaction",
]);

/**
 * Service-level properties whose methods are all async RPC calls. Accessing
 * one of these on the proxy returns a nested proxy that wraps each method
 * call.
 *
 * `core` is INTENTIONALLY EXCLUDED. The SDK's `core` is the unified
 * BaseClient with a mix of sync helpers (`resolveTransactionPlugin()` is the
 * load-bearing one for `tx.build()`) and async RPCs. Wrapping it
 * unconditionally turns the sync helpers into Promises and breaks the SDK's
 * `client.core?.X() ?? defaultX` fallback pattern. Our codebase doesn't
 * use `sui().core.X` directly, so passing it through is safe.
 */
const SERVICE_NAMES = new Set<string>([
  "ledgerService",
  "stateService",
  "transactionExecutionService",
  "movePackageService",
  "subscriptionService",
  "signatureVerificationService",
  "nameService",
]);

function buildFallbackProxy(): SuiGrpcClient {
  // Template client for shape probing, picks the first non-empty entry
  // from the registry. Methods are never CALLED through this instance;
  // it's only used so `Reflect.get(target, prop)` returns the right shape
  // for properties OUTSIDE our whitelist. Actual RPC calls go through
  // `suiGrpcWithFallback`, which constructs its own client per attempt.
  const net = network();
  let template: SuiGrpcClient | null = null;
  for (const ep of MAINNET_GRPC_ENDPOINTS) {
    template = buildClientForEndpoint(ep, net);
    if (template) break;
  }
  if (!template) {
    throw new Error(
      "sui(): no gRPC endpoint URL available, every entry in MAINNET_GRPC_ENDPOINTS was empty or missing its API key"
    );
  }

  // Cache nested service proxies so repeated `sui().ledgerService` access
  // returns the same object identity. Some callers cache the service
  // reference; respecting identity keeps their cache effective.
  const serviceProxyCache = new Map<string, unknown>();

  return new Proxy(template, {
    get(target, prop, receiver) {
      // Symbols + Promise-related properties: pass through untouched so we
      // don't accidentally make this look like a thenable.
      if (typeof prop === "symbol") {
        return Reflect.get(target, prop, receiver);
      }
      const name = prop as string;

      // Whitelisted top-level RPC method, wrap with fallback. Writes +
      // simulate bypass the Hayabusa read proxy (suiGrpcBroadcast); everything
      // else uses the Hayabusa-first read chain (suiGrpcWithFallback).
      if (TOP_LEVEL_RPC_METHODS.has(name)) {
        const runner = BROADCAST_METHODS.has(name)
          ? suiGrpcBroadcast
          : suiGrpcWithFallback;
        return async (...args: unknown[]) => {
          return runner(async (c) => {
            const fn = (c as unknown as Record<string, unknown>)[name] as (
              ...a: unknown[]
            ) => Promise<unknown>;
            return fn.call(c, ...args);
          });
        };
      }

      // Service-level property, return a nested proxy where every method
      // call goes through the fallback chain. The transaction-execution
      // service is writes by definition, so it bypasses the Hayabusa read
      // proxy (suiGrpcBroadcast); read services keep the Hayabusa-first chain.
      if (SERVICE_NAMES.has(name)) {
        if (serviceProxyCache.has(name)) {
          return serviceProxyCache.get(name);
        }
        const serviceRunner =
          name === "transactionExecutionService"
            ? suiGrpcBroadcast
            : suiGrpcWithFallback;
        const serviceProxy = new Proxy({}, {
          get(_svc, methodName) {
            if (typeof methodName === "symbol") return undefined;
            return async (...args: unknown[]) => {
              return serviceRunner(async (c) => {
                const svc = (c as unknown as Record<string, unknown>)[
                  name
                ] as Record<string, (...a: unknown[]) => Promise<unknown>>;
                return svc[methodName as string](...args);
              });
            };
          },
        });
        serviceProxyCache.set(name, serviceProxy);
        return serviceProxy;
      }

      // Anything else (SDK internals like resolveTransactionPlugin,
      // transport, network, options, etc.): pass through unmodified.
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function sui(): SuiGrpcClient {
  if (_grpc) return _grpc;
  _grpc = buildFallbackProxy();
  return _grpc;
}

// Eagerly construct the proxy + template gRPC channel at module load so the
// first request handler doesn't pay the ~50–150ms one-time cost of building
// the template client + the fallback proxy on the hot path. Safe: `sui()` is
// idempotent and synchronous (no network); the fallback chain only ever
// fires on actual RPC method calls. Wrapped in try/catch so a missing env
// in a build-time import doesn't blow up the whole module, the real call
// will throw clearly later if endpoints are still misconfigured.
try {
  void sui();
} catch {
  /* deferred to first real call */
}

// JSON-RPC was removed in Phase 5 of the Sui RPC migration. All point reads,
// executions, and lookups go through `sui()` (gRPC). Paginated history and
// multi-entity reads go through `suiGraphQL()` in `./sui-graphql.ts`. See
// `docs/sui-rpc-migration/migration-plan.md` for the full transport map.

/** Canonical coin types on Sui mainnet (and equivalents on testnet). */
export const COIN_TYPES = {
  SUI: "0x2::sui::SUI",
  // Native Circle USDC on Sui mainnet (verified against @mysten/deepbook-v3 constants)
  USDC: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  // DEEP, DeepBook governance / fee discount
  DEEP: "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
} as const;

export function suiscanAccountUrl(address: string): string {
  return `https://suiscan.xyz/${network()}/account/${address}`;
}
export function suiscanTxUrl(digest: string): string {
  return `https://suiscan.xyz/${network()}/tx/${digest}`;
}
export function suiscanObjectUrl(id: string): string {
  return `https://suiscan.xyz/${network()}/object/${id}`;
}

export async function getSuiBalance(address: string): Promise<{
  mist: string;
  sui: number;
}> {
  try {
    // gRPC `getBalance` returns `{ balance: { addressBalance, coinBalance,
    // balance, coinType } }`. `balance.balance` is the totalBalance.
    const res = await sui().getBalance({ owner: address });
    const mistStr = res.balance.balance;
    const suiNum = Number(BigInt(mistStr)) / 1e9;
    return { mist: mistStr, sui: suiNum };
  } catch (err) {
    console.warn(
      `[sui] getSuiBalance failed for ${address.slice(0, 10)}…: ${(err as Error)?.message ?? err}`
    );
    return { mist: "0", sui: 0 };
  }
}

export async function getUsdcBalance(address: string): Promise<{
  raw: string;
  usdc: number;
}> {
  try {
    const res = await sui().getBalance({
      owner: address,
      coinType: COIN_TYPES.USDC,
    });
    const raw = res.balance.balance;
    // Native USDC has 6 decimals
    const usdc = Number(BigInt(raw)) / 1e6;
    return { raw, usdc };
  } catch {
    return { raw: "0", usdc: 0 };
  }
}

/**
 * USDsui balance for an address. Mirrors `getUsdcBalance` but queries the
 * Sui-native USDsui coin type, our canonical settlement asset.
 */
export async function getUsdsuiBalance(address: string): Promise<{
  raw: string;
  usdsui: number;
}> {
  try {
    return await getUsdsuiBalanceStrict(address);
  } catch (err) {
    // Soft-fail variant for non-display callers. Never let a swallowed
    // failure be MISTAKEN for a genuine $0 in anything user-facing -
    // display paths should use the strict variant and handle the throw.
    console.warn(
      `[sui] getUsdsuiBalance failed for ${address.slice(0, 10)}…: ${(err as Error)?.message ?? err}`
    );
    return { raw: "0", usdsui: 0 };
  }
}

/**
 * Like `getUsdsuiBalance` but THROWS on a failed read instead of returning 0.
 * The headline-balance path must distinguish "the chain says zero" from "we
 * couldn't read the chain", on 2026-06-11 a transient gRPC failure was
 * swallowed to 0, write-through'd into the balance snapshot as source="chain",
 * and displayed as ₦0 to a user holding $22.84.
 */
export async function getUsdsuiBalanceStrict(address: string): Promise<{
  raw: string;
  usdsui: number;
}> {
  const res = await sui().getBalance({
    owner: address,
    coinType: USDSUI_TYPE,
  });
  const raw = res.balance.balance;
  const usdsui = Number(BigInt(raw)) / Math.pow(10, USDSUI_DECIMALS);
  return { raw, usdsui };
}

/** Format MIST string as human-readable SUI with up to 4 decimals. */
export function formatSui(mist: string | bigint): string {
  const n = typeof mist === "string" ? BigInt(mist) : mist;
  const whole = n / 1_000_000_000n;
  const frac = n % 1_000_000_000n;
  const fracStr = (Number(frac) / 1e9).toFixed(4).slice(2);
  return `${whole}.${fracStr}`;
}
