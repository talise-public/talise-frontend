import "server-only";

/**
 * Minimal Sui GraphQL client, additive read layer.
 *
 * Sits in parallel to `lib/sui.ts` (the JSON-RPC / gRPC client). It exists
 * because several heavy read paths spend most of their wall-clock waiting on
 * a fan-out of JSON-RPC calls that Sui's GraphQL endpoint can fold into a
 * single round-trip (or two, when one ID is dynamic on the previous):
 *
 *   - `/api/vault/state` used to issue 5+ RPCs: getObject(vault),
 *     getDynamicFields(bag), N × getObject(field), getOwnedObjects(caps).
 *     With GraphQL: ONE query fetches the vault contents (so we can extract
 *     the bag UID) AND filters the user's owned objects by AutoSwapCap type
 *     in the same response. A second query then reads every dynamic field on
 *     the bag with the nested Balance<T> value materialized in `json`. Net:
 *     5+ RPCs collapse to 2 GraphQL hits (and the second is single-page in
 *     the common case).
 *
 *   - `lib/activity.ts` resolves coin metadata for every unknown coin type
 *     it sees. `batchCoinMetadata` issues one POST with one alias per coin
 *     type, returning every result together.
 *
 * The write path (txs) stays on the JSON-RPC / gRPC client, GraphQL is
 * read-only here. Don't move signing/execution through this module.
 *
 * Implementation notes:
 *   - Plain `fetch` against the mainnet endpoint. No Apollo / urql; the
 *     surface we use is too small to justify a runtime dep.
 *   - Endpoint configurable via `SUI_GRAPHQL_URL` (default mainnet).
 *   - Tiny in-process TTL cache keyed by (query + variables). Most heavy
 *     reads repeat within a single render path so one cache layer pays for
 *     itself. The cache is process-wide (not per-request) so Next.js handler
 *     instances share it, matches the existing `coinInfoCache` /
 *     vault-state caches.
 *
 * Schema gotchas (Sui GraphQL):
 *   - Dynamic fields are queried via `address(address: $parentUid)`, i.e.
 *     the bag's UID address, NOT through `object(...).asMoveObject`. The
 *     parent we pass is the bag's `id.id`, not the vault id.
 *   - `MoveValue.json` represents `vector<u8>` as a **Base64 blob string**,
 *     not the numeric array that JSON-RPC emits. So the bag key (UTF-8 type
 *     name stored as bytes) comes back base64-encoded and we decode it.
 *   - `Object.asMoveObject` is nullable; non-Move addresses (packages, EOAs)
 *     return null there. The vault is always a Move object but the type-
 *     level nullability forces a defensive check.
 *   - `DynamicField.value` is a union of `MoveValue | MoveObject`. Balance<T>
 *     stored by-value lands on the `MoveValue` branch.
 *   - `Address.objects.filter.type` accepts a type-tag PREFIX too, passing
 *     `<pkg>::auto_swap::AutoSwapCap` matches every instantiation. This is
 *     how we filter caps without listing the user's full inventory.
 */

// Canonical Mysten-hosted mainnet GraphQL indexer. The legacy
// `sui-mainnet.mystenlabs.com` host was retired, it now refuses
// connections (`fetch failed`) from most networks, which silently broke
// `batchCoinMetadata` (it fell through to its catch and returned
// type-string-derived symbols with default 9 decimals on EVERY coin).
// `graphql.mainnet.sui.io` is the same host the SDK client below
// (`defaultGraphQLUrl`) and the integration smoke test already use, so
// every GraphQL path now resolves to one live endpoint.
const DEFAULT_ENDPOINT = "https://graphql.mainnet.sui.io/graphql";

function endpoint(): string {
  return process.env.SUI_GRAPHQL_URL || DEFAULT_ENDPOINT;
}

/** A GraphQL error shape as returned by the Sui GraphQL service. */
type GraphQLError = {
  message: string;
  path?: (string | number)[];
  locations?: { line: number; column: number }[];
  extensions?: Record<string, unknown>;
};

export class SuiGraphQLError extends Error {
  errors: GraphQLError[];
  constructor(errors: GraphQLError[]) {
    super(
      errors.length === 1
        ? errors[0].message
        : `GraphQL errors: ${errors.map((e) => e.message).join("; ")}`
    );
    this.name = "SuiGraphQLError";
    this.errors = errors;
  }
}

/** 10s TTL, same horizon as the existing per-user vault-state cache. */
const CACHE_TTL_MS = 10_000;
// 512 (was 256): write-once coin-metadata entries and time-windowed
// tx-history entries share this LRU, so under concurrent users a small cap
// evicts still-valid metadata and forces extra GraphQL round-trips. 512
// keeps the working set resident without meaningful memory cost.
const CACHE_MAX_ENTRIES = 512;

type CacheEntry = { at: number; data: unknown };
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): unknown | undefined {
  const e = cache.get(key);
  if (!e) return undefined;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  // LRU touch: re-insert to move to end of insertion-order iteration.
  cache.delete(key);
  cache.set(key, e);
  return e.data;
}

function cacheSet(key: string, data: unknown) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Drop the oldest (insertion-ordered) entry.
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, { at: Date.now(), data });
}

/**
 * Execute a GraphQL query against the Sui mainnet endpoint and return the
 * `data` field. Throws `SuiGraphQLError` if the server reports errors or if
 * the response body is malformed.
 *
 * Set `noCache: true` to bypass the in-process cache.
 */
export async function gql<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
  opts: { noCache?: boolean; signal?: AbortSignal } = {}
): Promise<T> {
  const key = `${query}|${JSON.stringify(variables)}`;
  if (!opts.noCache) {
    const hit = cacheGet(key);
    if (hit !== undefined) return hit as T;
  }

  const body = JSON.stringify({ query, variables });
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    // Default a 10s ceiling so callers that don't pass a signal (e.g.
    // /api/me/nfts) can't hang on a slow GraphQL endpoint. An explicit
    // caller signal still takes precedence.
    signal: opts.signal ?? AbortSignal.timeout(10_000),
    // Next.js' fetch-cache integration would persist this server-side across
    // requests, which is exactly what we DON'T want for live chain data.
    cache: "no-store",
  });
  if (!res.ok) {
    throw new SuiGraphQLError([
      { message: `HTTP ${res.status} ${res.statusText}` },
    ]);
  }
  const json = (await res.json()) as {
    data?: T;
    errors?: GraphQLError[];
  };
  if (json.errors && json.errors.length > 0) {
    throw new SuiGraphQLError(json.errors);
  }
  if (json.data === undefined) {
    throw new SuiGraphQLError([{ message: "empty data field in response" }]);
  }
  if (!opts.noCache) cacheSet(key, json.data);
  return json.data as T;
}

/** Drop every cached response. Test-only helper. */
export function _clearGraphQLCache() {
  cache.clear();
}

// ───────────────────────────────────────────────────────────────────
// Vault state query, vault contents + caps in one POST.
//
// We deliberately split this from the bag-DF read because the bag's UID is
// only known after parsing the vault contents. The two queries together still
// beat 5+ JSON-RPC round-trips and avoid the per-field getObject explosion.

export type GraphQLVaultAndCapsResponse = {
  vault: {
    address: string;
    asMoveObject: {
      contents: {
        type: { repr: string };
        json: unknown;
      } | null;
    } | null;
  } | null;
  owner: {
    objects: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        address: string;
        contents: {
          type: { repr: string };
          json: unknown;
        } | null;
      }>;
    };
  } | null;
};

/**
 * Single GraphQL query covering:
 *   - vault Move object contents (to discover bag id + verify shape)
 *   - owned objects filtered by AutoSwapCap<...> type prefix
 *
 * `$vaultId` may be null (user hasn't created a vault yet). When it is,
 * the `vault` branch yields null and the caller skips bag DF traversal.
 */
export const VAULT_AND_CAPS_QUERY = /* GraphQL */ `
  query VaultAndCaps(
    $vaultId: SuiAddress
    $owner: SuiAddress!
    $capType: String!
    $first: Int!
    $afterObj: String
  ) {
    vault: object(address: $vaultId) {
      address
      asMoveObject {
        contents {
          type {
            repr
          }
          json
        }
      }
    }
    owner: address(address: $owner) {
      objects(first: $first, after: $afterObj, filter: { type: $capType }) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          address
          contents {
            type {
              repr
            }
            json
          }
        }
      }
    }
  }
`;

export type GraphQLBagDynamicFieldsResponse = {
  address: {
    dynamicFields: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        name: { json: unknown; type: { repr: string } };
        value:
          | {
              __typename: "MoveValue";
              json: unknown;
              type: { repr: string };
            }
          | {
              __typename: "MoveObject";
              address: string;
              contents: { json: unknown; type: { repr: string } } | null;
            }
          | null;
      }>;
    } | null;
  } | null;
};

/**
 * Dynamic fields on a bag UID, paginated.
 *
 * For Talise vaults the typical user holds <10 coin types so a single page
 * (default 50) suffices. The caller still handles cursor continuation
 * defensively for the rare power-user case.
 */
export const BAG_DYNAMIC_FIELDS_QUERY = /* GraphQL */ `
  query BagDynamicFields(
    $bagId: SuiAddress!
    $first: Int!
    $after: String
  ) {
    address(address: $bagId) {
      dynamicFields(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          name {
            json
            type {
              repr
            }
          }
          value {
            __typename
            ... on MoveValue {
              json
              type {
                repr
              }
            }
            ... on MoveObject {
              address
              contents {
                json
                type {
                  repr
                }
              }
            }
          }
        }
      }
    }
  }
`;

// ───────────────────────────────────────────────────────────────────
// Batch coin-metadata lookup.

/**
 * Sui GraphQL exposes `coinMetadata(coinType: String!) -> CoinMetadata`.
 * Returns null when no metadata is registered for the type.
 *
 * We synthesize one aliased field per type so a single POST returns all
 * results. The alias is `m{idx}`, with the type passed via a variable; the
 * type-tag never enters the query string itself so injection isn't possible.
 */
type GraphQLCoinMetadata = {
  symbol: string | null;
  decimals: number | null;
  name: string | null;
} | null;

export async function batchCoinMetadata(
  coinTypes: string[]
): Promise<Map<string, { symbol: string; decimals: number }>> {
  const out = new Map<string, { symbol: string; decimals: number }>();
  // De-dupe first; many activity rows reference the same type.
  const unique = Array.from(new Set(coinTypes.filter((t) => !!t)));
  if (unique.length === 0) return out;

  // Build a single query with one alias per type.
  const aliasLines = unique.map(
    (_, i) =>
      `  m${i}: coinMetadata(coinType: $t${i}) { symbol decimals name }`
  );
  const varDecls = unique.map((_, i) => `$t${i}: String!`).join(", ");
  const query = `query BatchCoinMetadata(${varDecls}) {\n${aliasLines.join(
    "\n"
  )}\n}`;
  const variables: Record<string, unknown> = {};
  unique.forEach((t, i) => {
    variables[`t${i}`] = t;
  });

  try {
    const data = await gql<Record<string, GraphQLCoinMetadata>>(
      query,
      variables
    );
    unique.forEach((t, i) => {
      const m = data[`m${i}`];
      if (m && (m.symbol || typeof m.decimals === "number")) {
        out.set(t, {
          symbol: m.symbol || coinSymbolFromType(t),
          decimals: typeof m.decimals === "number" ? m.decimals : 9,
        });
      } else {
        out.set(t, { symbol: coinSymbolFromType(t), decimals: 9 });
      }
    });
  } catch {
    // Failure mode mirrors the original per-call try/catch, fall back to
    // a type-string-derived symbol with default 9 decimals.
    for (const t of unique) {
      out.set(t, { symbol: coinSymbolFromType(t), decimals: 9 });
    }
  }
  return out;
}

/** Last `::Name` segment of a Move type, uppercased. `WAL`, `USDC`. */
function coinSymbolFromType(coinType: string): string {
  const parts = coinType.split("::");
  const last = parts[parts.length - 1] || "COIN";
  return last.toUpperCase().slice(0, 12);
}

// ───────────────────────────────────────────────────────────────────
// Helpers for decoding `MoveValue.json` byte-vector payloads.

/**
 * Decode the `name.json` of a Bag<vector<u8>, T> dynamic field. The Sui
 * GraphQL `MoveValue.json` representation returns `vector<u8>` as a single
 * **Base64-encoded string** rather than a numeric array. This is the key
 * representational difference from JSON-RPC and the one that catches every
 * first-time migration.
 *
 * We also accept the legacy numeric-array form (in case the schema flips
 * back, or the value comes from somewhere else) and a plain UTF-8 string.
 */
export function decodeBagKeyVectorU8(value: unknown): string {
  if (typeof value === "string") {
    // Try Base64 first; if the decode produces valid UTF-8 with printable
    // characters, treat it as the GraphQL representation. Otherwise fall
    // back to the raw string (caller can decide).
    try {
      const buf = Buffer.from(value, "base64");
      const s = buf.toString("utf8");
      // Cheap sanity check, Move type-name strings only ever contain
      // printable ASCII (alphanumerics, `:`, `<`, `>`, `_`, `0x` hex). If
      // that holds, the base64 decode was correct.
      if (s.length > 0 && /^[\x20-\x7e]+$/.test(s)) return s;
    } catch {
      /* fall through */
    }
    return value;
  }
  if (Array.isArray(value)) {
    try {
      return Buffer.from(value as number[]).toString("utf8");
    } catch {
      return "";
    }
  }
  return "";
}

// ─── SDK GraphQL client (singleton) ───────────────────────────────────────────
// Everything above this line is the hand-rolled fetch + cache layer that backs
// `/api/vault/state`, `lib/activity.ts`, and `/api/balances`. The exports below
// are a thin singleton wrapper around `@mysten/sui/graphql`'s `SuiGraphQLClient`
// so new call sites can use the typed SDK surface (`gql.tada`-style documents)
// without each one paying for client construction. Mirrors the `sui()` /
// `sui()` pattern in `./sui.ts`, same network resolution, same
// process-wide cache key (network + url) so a single
// `NEXT_PUBLIC_SUI_NETWORK` env var keeps every client in lockstep.

import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { network, type Network } from "./sui";

/**
 * Re-export the `graphql` tagged-template helper from
 * `@mysten/sui/graphql/schema` so callers can author typed GraphQL documents
 * alongside the client they grab from this module.
 */
export { graphql } from "@mysten/sui/graphql/schema";

/**
 * Default GraphQL endpoint for a given Sui network. Mysten's hosted indexer
 * serves both mainnet and testnet at well-known URLs. An env override
 * (`SUI_GRAPHQL_URL` / `NEXT_PUBLIC_SUI_GRAPHQL_URL`) lets us point at a
 * private endpoint without code changes, mirroring `defaultGrpcBaseUrl` in
 * `./sui.ts`. We share the env var with the fetch-based layer above so
 * overrides apply to both.
 */
function defaultGraphQLUrl(net: Network): string {
  const fromEnv =
    process.env.SUI_GRAPHQL_URL ?? process.env.NEXT_PUBLIC_SUI_GRAPHQL_URL;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  return net === "mainnet"
    ? "https://graphql.mainnet.sui.io/graphql"
    : "https://graphql.testnet.sui.io/graphql";
}

let _gqlClient: SuiGraphQLClient | null = null;
let _gqlClientKey = "";

/**
 * Cached `SuiGraphQLClient` for the active network. Prefer this over hand-
 * rolled `fetch` for new call sites, it integrates with `graphql` typed
 * documents and matches the singleton ergonomics of `sui()`.
 */
export function suiGraphQL(): SuiGraphQLClient {
  const net = network();
  const url = defaultGraphQLUrl(net);
  const key = `${net}:${url}`;
  if (_gqlClient && _gqlClientKey === key) return _gqlClient;
  _gqlClient = new SuiGraphQLClient({ url, network: net });
  _gqlClientKey = key;
  return _gqlClient;
}

// Eagerly construct the GraphQL client singleton at module load so the
// first request handler doesn't pay the (~30–80ms) one-time client
// construction on the hot path. Mirrors the `void sui()` pre-warm
// pattern in `./sui.ts`. Safe: `suiGraphQL()` is synchronous and only
// builds the client object (no network). Wrapped in try/catch so a
// missing env at build-time import doesn't crash module init.
try {
  void suiGraphQL();
} catch {
  /* deferred to first real call */
}
