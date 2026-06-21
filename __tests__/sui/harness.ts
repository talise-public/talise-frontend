/**
 * Integration-test harness for the Sui RPC migration.
 *
 * Provides cached, mainnet-pointed clients (gRPC + GraphQL) plus a couple of
 * well-known on-chain artifacts to query against. Tests here hit the real
 * mainnet fullnode — they are slow + network-dependent, and intentionally
 * excluded from the default test run. See `vitest.integration.config.ts` and
 * the `test:integration` script in `package.json`.
 *
 * Phase 4 will fill in concrete tests; this module just gives them a clean
 * place to live.
 */

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiGraphQLClient } from "@mysten/sui/graphql";

const MAINNET_GRPC_URL = "https://fullnode.mainnet.sui.io:443";
// Canonical Mysten mainnet GraphQL indexer. The previous
// `sui-mainnet.mystenlabs.com` host was retired and now refuses
// connections (`fetch failed`), which silently broke every test that
// reached for `getGraphQLClient()`. Mirror the live host used by
// `lib/sui-graphql.ts` so harness + lib agree.
const MAINNET_GRAPHQL_URL = "https://graphql.mainnet.sui.io/graphql";

let _grpc: SuiGrpcClient | null = null;
let _graphql: SuiGraphQLClient | null = null;

/**
 * Cached SuiGrpcClient pointed at Sui mainnet (read-only). Fresh per process,
 * memoized for the lifetime of the test run.
 */
export function getGrpcClient(): SuiGrpcClient {
  if (_grpc) return _grpc;
  _grpc = new SuiGrpcClient({
    network: "mainnet",
    baseUrl: MAINNET_GRPC_URL,
  });
  return _grpc;
}

/**
 * Cached SuiGraphQLClient pointed at Sui mainnet. Fresh per process, memoized
 * for the lifetime of the test run.
 */
export function getGraphQLClient(): SuiGraphQLClient {
  if (_graphql) return _graphql;
  _graphql = new SuiGraphQLClient({
    url: MAINNET_GRAPHQL_URL,
    network: "mainnet",
  });
  return _graphql;
}

/**
 * A long-lived mainnet transaction digest. Used by tests that need to assert
 * `getTransaction`-style reads work end-to-end. If this ever pruned from the
 * network it should be replaced with another known-good mainnet digest.
 *
 * TODO(phase-4): verify this digest is still queryable; pin a digest from
 * `web/lib/activity.ts` test fixtures if/when those exist.
 */
export const KNOWN_MAINNET_DIGEST =
  "5LCB3JN6CcS3VppDDP9TVk1eyXkkzfXP49wQq7gFkbtL";

/**
 * The Sui system state object id (0x5). It always exists on every Sui network,
 * which makes it a safe canary for "does the client work at all?" smoke tests
 * — no risk of false negatives from a missing user account.
 */
export const KNOWN_MAINNET_ADDRESS =
  "0x0000000000000000000000000000000000000000000000000000000000000005";

/**
 * The Sui framework package (0x2). Permanent, and it itself HOLDS SUI
 * (~thousands of SUI in fee/gas-pool flows), so it is a stable target for a
 * gRPC `getBalance` shape + non-zero balance assertion. It is also
 * `affectedAddress` of a continuous tx stream, but note: as a *package* it
 * is rarely the BALANCE-CHANGE OWNER, so the `lib/activity.ts` classifier
 * (which keys off owner-side deltas) produces an empty feed for it. Use
 * `discoverActiveCoinOwner()` for the activity-feed tests instead.
 */
export const ACTIVE_MAINNET_ADDRESS =
  "0x0000000000000000000000000000000000000000000000000000000000000002";

/**
 * A pinned, recently-verified mainnet address that OWNS frequently-moving
 * coin balances (SUI + assorted tokens). Used as the fallback for the
 * activity-feed tests when live discovery returns nothing. Verified
 * 2026-05-31: appears as a balance-change owner in ~30/30 recent txs.
 */
export const PINNED_ACTIVE_COIN_OWNER =
  "0x0087e2be81314d421ed3a593d5ab796ee30f82f6e96f99ce508b7f4459818aad";

/**
 * Discover an address that currently OWNS moving coin balances on mainnet,
 * by harvesting the balance-change owners of the most recent global txs and
 * returning the most frequently-appearing one. This keeps the activity-feed
 * tests self-healing: even if the pinned fixture goes quiet, the test picks
 * a live coin-owning address so it always exercises the real
 * GraphQL → adapter → classifier pipeline with populated data.
 *
 * Falls back to `PINNED_ACTIVE_COIN_OWNER` on any error / empty harvest.
 */
export async function discoverActiveCoinOwner(): Promise<string> {
  try {
    const c = getGraphQLClient();
    const res = (await c.query({
      query: /* GraphQL */ `
        query RecentGlobal {
          transactions(last: 50) {
            nodes { effects { balanceChangesJson } }
          }
        }
      `,
      variables: {},
    })) as {
      data?: {
        transactions?: {
          nodes: Array<{
            effects: { balanceChangesJson: unknown | null } | null;
          }>;
        };
      };
    };
    const freq = new Map<string, number>();
    for (const node of res.data?.transactions?.nodes ?? []) {
      const bc = node.effects?.balanceChangesJson;
      if (!Array.isArray(bc)) continue;
      for (const b of bc as Array<{ address?: string }>) {
        // Skip object/package addresses (0x2..0x6) — they aren't EOAs and
        // their deltas are system internals; we want a real coin owner.
        const a = b.address;
        if (!a) continue;
        if (/^0x0{63}[0-9a-f]$/.test(a)) continue;
        freq.set(a, (freq.get(a) ?? 0) + 1);
      }
    }
    let best: string | null = null;
    let bestN = 0;
    for (const [addr, n] of freq) {
      if (n > bestN) {
        bestN = n;
        best = addr;
      }
    }
    return best ?? PINNED_ACTIVE_COIN_OWNER;
  } catch {
    return PINNED_ACTIVE_COIN_OWNER;
  }
}

/**
 * The canonical Sui MAINNET chain identifier (the genesis checkpoint
 * digest, base58). Stable for the life of the network. Used to assert
 * `getChainIdentifier` / `getServiceInfo().chainId` actually hit mainnet
 * and not testnet/devnet.
 */
export const MAINNET_CHAIN_IDENTIFIER =
  "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S";
