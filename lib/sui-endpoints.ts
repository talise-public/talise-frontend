/**
 * Sui mainnet gRPC endpoint registry + multi-provider fallback wrapper.
 *
 * Why this exists:
 *   Today's outage on `fullnode.mainnet.sui.io:443` (503 no_healthy_upstream)
 *   took down our iOS gRPC test run and 10/43 web integration tests. This
 *   module provides a fallback chain so a single Mysten node failure no
 *   longer takes the app offline.
 *
 * Wiring: `sui()` (lib/sui.ts) routes every whitelisted gRPC method through
 * `suiGrpcWithFallback` over this chain. The chain is PRIMARY-first; the head
 * is Hayabusa (a transparent gRPC-Web proxy that races + caches across
 * fullnodes), so reads/broadcasts get the fastest backend with automatic
 * fallback to the direct fullnodes below.
 *
 * See: docs/sui-rpc-migration/endpoints.md, docs/integrations/hayabusa.md
 */

import { SuiGrpcClient } from "@mysten/sui/grpc";

type Network = "testnet" | "mainnet";

/**
 * Local network(), copy of `./sui` so this module has no import cycle with
 * the canonical client wiring. Kept tiny on purpose; if the canonical
 * `sui()` ever changes its env-var contract, mirror that change here too.
 */
function network(): Network {
  const v = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? "mainnet").toLowerCase();
  return v === "testnet" ? "testnet" : "mainnet";
}

// ─── Endpoint registry ────────────────────────────────────────────────────────

/**
 * One entry in the fallback chain. Ordered list lives in
 * `MAINNET_GRPC_ENDPOINTS`. Anything with `requiresAuth: true` reads the
 * key from the env var named in `apiKeyEnv`; if that env var is unset the
 * wrapper SKIPS the endpoint (does not throw).
 */
export type SuiGrpcEndpoint = {
  /** Full base URL (scheme + host + port). gRPC-Web speaks HTTPS. */
  readonly url: string;
  /** Human-readable provider name (used in telemetry). */
  readonly provider: string;
  /** Whether the wrapper should attempt this endpoint without an API key. */
  readonly requiresAuth: boolean;
  /** Env var name that holds the API key (only meaningful if requiresAuth). */
  readonly apiKeyEnv?: string;
  /** Header name to send the API key under (e.g. `x-api-key`). */
  readonly apiKeyHeader?: string;
};

/**
 * Ordered Sui MAINNET gRPC endpoints, preferred first.
 *
 * The ordering is biased toward (a) free + already-default and (b)
 * providers we already have a working key for. Anything paid-with-no-key
 * is included for completeness but is INERT until the relevant env var is
 * set, the wrapper skips it cleanly.
 */
export const MAINNET_GRPC_ENDPOINTS: ReadonlyArray<SuiGrpcEndpoint> = [
  {
    // Hayabusa (unconfirmedlabs), a transparent Sui gRPC-Web PROXY that races
    // requests to multiple fullnodes (hedged) and serves immutable responses
    // from a two-tier cache, returning the fastest result. It's drop-in: any
    // SuiGrpcClient works unmodified by pointing baseUrl at it. Placed FIRST so
    // every gRPC read + the broadcast leg go through it; on any transient
    // failure the chain falls straight through to the direct fullnodes below.
    // Env-overridable kill switch: set HAYABUSA_GRPC_URL="" to bypass it.
    // (Hayabusa is a query/transport accelerator, NOT a gas sponsor; Onara
    // still signs sponsorship. See docs/integrations/hayabusa.md.)
    url:
      process.env.HAYABUSA_GRPC_URL ??
      "https://hayabusa.mainnet.unconfirmed.cloud:443",
    provider: "hayabusa",
    requiresAuth: false,
  },
  {
    url: "https://fullnode.mainnet.sui.io:443",
    provider: "mysten-fullnode",
    requiresAuth: false,
  },
  // NOTE (2026-05-31): `https://archive.mainnet.sui.io:443` was REMOVED from
  // this chain. It was sitting at position #2 but does NOT serve the gRPC
  // API, every method (getReferenceGasPrice, getObject, getServiceInfo)
  // returns `RpcError { code: "NOT_FOUND", message: "Not Found" }` and a
  // plain `curl` of the host root returns HTTP 404. With it here, a primary
  // (`fullnode`) outage fell THROUGH to this dead host and, because
  // `NOT_FOUND` wasn't fallback-eligible, the wrapper threw "Not Found"
  // instead of advancing to Shinami/Dwellir, defeating the entire point of
  // the fallback chain during the very outage it exists to survive. The
  // chain now goes straight from the public fullnode to the keyed providers.
  // `isFallbackEligible` was ALSO hardened to treat a `NOT_FOUND` /
  // `UNIMPLEMENTED` gRPC status as eligible so any future host that 404s the
  // gRPC service is skipped rather than killing the chain.
  {
    // Shinami, we already use them for zkLogin + gas station and have a
    // mainnet US1 key in .env.local under SHINAMI_API_KEY.
    url: "https://api.us1.shinami.com/sui/node/v1",
    provider: "shinami",
    requiresAuth: true,
    apiKeyEnv: "SHINAMI_API_KEY",
    apiKeyHeader: "X-Api-Key",
  },
  {
    // Dwellir, header auth via `x-api-key`. Requires DWELLIR_API_KEY.
    url: "https://api-sui-mainnet-full.n.dwellir.com:443",
    provider: "dwellir",
    requiresAuth: true,
    apiKeyEnv: "DWELLIR_API_KEY",
    apiKeyHeader: "x-api-key",
  },
  {
    // QuickNode, token is baked into the URL host (e.g.
    // `https://<token>.sui-mainnet.quiknode.pro:9000`). We expect the
    // operator to paste the FULL URL into QUICKNODE_SUI_GRPC_URL rather
    // than re-implementing token-in-URL composition here.
    url: process.env.QUICKNODE_SUI_GRPC_URL ?? "",
    provider: "quicknode",
    requiresAuth: true,
    apiKeyEnv: "QUICKNODE_SUI_GRPC_URL",
  },
];

// ─── Errors we should fall back on ────────────────────────────────────────────

/**
 * Returns true if an error from `SuiGrpcClient` is the kind we should retry
 * against the next endpoint in the chain.
 *
 * `@protobuf-ts/runtime-rpc` throws `RpcError` with a string `code` field
 * (e.g. `"UNAVAILABLE"`, `"DEADLINE_EXCEEDED"`). Fetch / network errors
 * surface as plain `Error` / `TypeError` whose message contains `503`,
 * `502`, `504`, or `fetch failed`. Be liberal about both, fallback is the
 * safe direction.
 */
export function isFallbackEligible(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: unknown; message?: unknown; name?: unknown };
  const code = typeof e.code === "string" ? e.code.toLowerCase() : "";
  if (code === "unavailable" || code === "deadline_exceeded") return true;
  // `NOT_FOUND` / `UNIMPLEMENTED` as a TRANSPORT-level gRPC status (i.e. the
  // RpcError `.code` field is set) means "this host doesn't speak our gRPC
  // service", a per-endpoint capability problem, NOT a bad request. The
  // dead `archive.mainnet.sui.io` host returned exactly this
  // (`RpcError { code: "NOT_FOUND", message: "Not Found" }`). Skip to the
  // next provider. A LEGITIMATE missing object from a healthy fullnode does
  // NOT set `.code` (it surfaces as `code: undefined` with a descriptive
  // "Object 0x… not found" message), so this stays safely scoped to the
  // transport signature and never fans out on a real not-found result.
  if (code === "not_found" || code === "unimplemented") return true;
  // Numeric gRPC codes: 14 = UNAVAILABLE, 4 = DEADLINE_EXCEEDED,
  // 5 = NOT_FOUND, 12 = UNIMPLEMENTED.
  if (
    typeof e.code === "number" &&
    (e.code === 14 || e.code === 4 || e.code === 5 || e.code === 12)
  ) {
    return true;
  }
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (
    msg.includes("no_healthy_upstream") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("504") ||
    msg.includes("500") ||
    // Gateways return the STATUS TEXT, not the number, the public fullnode
    // 502s on executeTransaction as a bare "Bad Gateway", which contains no
    // "502" substring, so the chain never failed over (the cheque-claim
    // broadcast bug). Match the text forms too.
    msg.includes("bad gateway") ||
    msg.includes("gateway timeout") ||
    msg.includes("service unavailable") ||
    msg.includes("internal server error") ||
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    msg.includes("unavailable") ||
    msg.includes("deadline")
  ) {
    return true;
  }
  if (typeof e.name === "string" && e.name === "AbortError") return true;
  return false;
}

// ─── Per-endpoint client factory ──────────────────────────────────────────────

/**
 * Build a one-off `SuiGrpcClient` against a specific endpoint. Returns
 * `null` when the endpoint requires auth and the env var is unset (or the
 * URL itself is empty, QuickNode's case).
 *
 * The `meta` field is `@protobuf-ts/grpcweb-transport`'s metadata bag,
 * which translates to HTTP headers on the wire. Per-provider header
 * conventions:
 *   - Shinami: `X-Api-Key`
 *   - Dwellir: `x-api-key`
 *   - QuickNode: token baked into the URL, no header needed.
 */
// One SuiGrpcClient per (network, endpoint URL). The client wraps a gRPC-web
// transport; rebuilding it on every RPC threw away HTTP/2 connection reuse, so
// gas-price / simulate / broadcast each paid a fresh handshake. The headers are
// derived from stable per-process env, so (net,url) uniquely identifies a
// client, and gRPC transports reconnect internally — safe to keep hot.
const grpcClientCache = new Map<string, SuiGrpcClient>();

export function buildClientForEndpoint(
  endpoint: SuiGrpcEndpoint,
  net: Network,
): SuiGrpcClient | null {
  if (!endpoint.url || endpoint.url.trim().length === 0) return null;

  const cacheKey = `${net}|${endpoint.url}`;
  const cached = grpcClientCache.get(cacheKey);
  if (cached) return cached;

  let meta: Record<string, string> | undefined;
  if (endpoint.requiresAuth) {
    const envName = endpoint.apiKeyEnv;
    const key = envName ? process.env[envName] : undefined;
    if (!key || key.trim().length === 0) {
      // Endpoint declared paid but no key configured, skip it.
      return null;
    }
    if (endpoint.apiKeyHeader) {
      meta = { [endpoint.apiKeyHeader]: key };
    }
    // QuickNode's "key" IS the URL, no header to set in that path.
  }

  const client = new SuiGrpcClient({
    network: net,
    baseUrl: endpoint.url,
    ...(meta ? { meta } : {}),
  });
  grpcClientCache.set(cacheKey, client);
  return client;
}

// ─── Fallback wrapper ─────────────────────────────────────────────────────────

/**
 * Run `fn` against the first reachable endpoint in `MAINNET_GRPC_ENDPOINTS`,
 * falling back on `UNAVAILABLE` / `DEADLINE_EXCEEDED` / 5xx-class errors.
 *
 * Returns the result of the first successful call. If every endpoint fails,
 * throws the LAST error so the caller sees the most-recent provider's
 * message (not the stale Mysten 503).
 *
 * Usage:
 *   const balance = await suiGrpcWithFallback((c) =>
 *     c.getBalance({ owner: address, coinType: COIN_TYPES.SUI }),
 *   );
 */
/**
 * Per-endpoint deadline. Without it, a *hung* upstream (slow, not erroring)
 * never triggers the fallback, the await just blocks, and a single bad
 * provider hangs the whole request for tens of seconds. With it, a slow
 * endpoint is treated as transient and we fail over to the next. Env-tunable
 * via SUI_GRPC_ENDPOINT_TIMEOUT_MS.
 *
 * With 7 endpoints in the chain, a generous value stacks: a 4s deadline gave
 * ~28-40s worst-case reads when several nodes were unhealthy (the slow balance
 * loads). 2.2s is ample for a healthy node to answer ONE read; an unhealthy one
 * is abandoned fast so the chain advances quickly to a node that works.
 */
const PER_ENDPOINT_TIMEOUT_MS = Number(process.env.SUI_GRPC_ENDPOINT_TIMEOUT_MS) || 2200;

class GrpcEndpointTimeout extends Error {
  constructor() {
    super(`gRPC endpoint exceeded ${PER_ENDPOINT_TIMEOUT_MS}ms`);
    this.name = "GrpcEndpointTimeout";
  }
}

function withEndpointTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new GrpcEndpointTimeout()), PER_ENDPOINT_TIMEOUT_MS);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export async function suiGrpcWithFallback<T>(
  fn: (client: SuiGrpcClient) => Promise<T>,
): Promise<T> {
  const net = network();
  // Mainnet-only for now. Testnet path is a follow-up.
  if (net !== "mainnet") {
    throw new Error(
      `suiGrpcWithFallback: only mainnet is supported (got ${net})`,
    );
  }

  let lastErr: unknown = new Error("no endpoints attempted");
  let attempted = 0;
  for (const endpoint of MAINNET_GRPC_ENDPOINTS) {
    const client = buildClientForEndpoint(endpoint, net);
    if (!client) continue; // skipped (no key / empty URL)
    attempted += 1;
    try {
      return await withEndpointTimeout(fn(client));
    } catch (err) {
      lastErr = err;
      // A hung/slow endpoint (timeout) OR a transient 5xx/UNAVAILABLE → fail
      // over to the next provider. A real application error (bad request) is
      // not transient → fail fast rather than blowing through every provider.
      if (err instanceof GrpcEndpointTimeout || isFallbackEligible(err)) {
        continue;
      }
      throw err;
    }
  }

  if (attempted === 0) {
    throw new Error(
      "suiGrpcWithFallback: no endpoints were attempted (every paid endpoint missing its API key, and the public Mysten endpoint URL was empty)",
    );
  }
  throw lastErr;
}

// ─── Write / simulate path (Hayabusa-excluded) ────────────────────────────────

/**
 * Provider names that are READ/cache accelerators and MUST NOT receive a write
 * or a simulation. Hayabusa is a gRPC-Web proxy that races + caches IMMUTABLE
 * reads; it flatly `PERMISSION_DENIED` ("Forbidden")s `executeTransaction` and
 * 502s ("Bad Gateway") on `simulateTransaction`. Worse, neither error is
 * `isFallbackEligible`, so a write/simulate routed through the normal chain
 * dies on Hayabusa and never reaches the direct fullnode behind it, which is
 * exactly why Save-OFF gasless sends failed while the sponsored rail (Onara
 * HTTP, no gRPC) worked. Empirically proven: scripts/probe-hayabusa-execute.mjs.
 */
const WRITE_INELIGIBLE_PROVIDERS = new Set<string>(["hayabusa"]);

/**
 * Like `suiGrpcWithFallback`, but for WRITE / SIMULATE calls
 * (`executeTransaction`, `simulateTransaction`, `signAndExecuteTransaction`).
 * Walks the SAME ordered chain but SKIPS read-only proxies (Hayabusa) entirely,
 * sending the call straight to the direct fullnodes (mysten-fullnode → Shinami
 * → Dwellir → QuickNode) with the usual transient-error fallback between them.
 *
 * A broadcast must never even be ATTEMPTED on a caching/racing read layer -
 * both because it just fails there and because we never want a cache anywhere
 * near a transaction submission. Excluding it up front is correct and cheaper
 * than failing-then-falling-through.
 */
export async function suiGrpcBroadcast<T>(
  fn: (client: SuiGrpcClient) => Promise<T>,
): Promise<T> {
  const net = network();
  if (net !== "mainnet") {
    throw new Error(`suiGrpcBroadcast: only mainnet is supported (got ${net})`);
  }

  let lastErr: unknown = new Error("no broadcast endpoints attempted");
  let attempted = 0;
  for (const endpoint of MAINNET_GRPC_ENDPOINTS) {
    if (WRITE_INELIGIBLE_PROVIDERS.has(endpoint.provider)) continue; // never broadcast through a read proxy
    const client = buildClientForEndpoint(endpoint, net);
    if (!client) continue; // skipped (no key / empty URL)
    attempted += 1;
    try {
      return await fn(client);
    } catch (err) {
      lastErr = err;
      if (!isFallbackEligible(err)) throw err;
      continue;
    }
  }

  if (attempted === 0) {
    throw new Error(
      "suiGrpcBroadcast: no direct fullnode endpoints were attempted (Hayabusa is excluded for writes; every direct endpoint was empty or missing its API key)",
    );
  }
  throw lastErr;
}
