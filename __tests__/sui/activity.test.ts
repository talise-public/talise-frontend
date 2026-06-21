/**
 * Integration test for `getRecentActivity` after the GraphQL migration
 * (sub-plan 1.8). Hits real Sui mainnet via the GraphQL endpoint and
 * asserts:
 *
 *   1. The function returns a well-shaped `ActivityEntry[]` (no throws,
 *      correct keys present on every row).
 *   2. The result is sorted newest-first (by `timestampMs` desc).
 *   3. Every entry has a unique digest (the dedupe step did its job —
 *      with `affectedAddress` filtering we should never produce dupes
 *      for "sent + received" the same tx, but the dedupe is still
 *      defensive against vault-event overlap).
 *
 * Address selection: the harness's `KNOWN_MAINNET_ADDRESS` is the Sui
 * system state object (0x5), which has zero `transactionBlocks`
 * history. We use a well-known active mainnet address instead — a
 * Mysten Labs deployer with steady tx flow. If activity drops to zero
 * we still assert the shape but skip the non-empty assertion.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { getRecentActivity, type ActivityEntry } from "../../lib/activity";
import {
  suiGraphQL,
  batchCoinMetadata,
  _clearGraphQLCache,
} from "../../lib/sui-graphql";
import {
  discoverActiveCoinOwner,
  PINNED_ACTIVE_COIN_OWNER,
} from "./harness";

// An address that OWNS frequently-moving coin balances on mainnet. We
// DISCOVER it at runtime (harvest balance-change owners from the recent
// global tx stream) so the test is self-healing — it always lands on a
// live coin owner whose feed actually exercises the GraphQL → adapter →
// classifier pipeline with real data. Falls back to a pinned fixture.
//
// The previous fixtures (`0x6da0…a3a3`, `0xa1ec…7e29`) returned ZERO rows
// via the `transactions(affectedAddress:)` filter on mainnet (verified
// 2026-05-31), so the "populated feed" assertions passed vacuously and
// never touched the parser. Package objects like 0x2/0x6 likewise have no
// owner-side balance deltas. A real coin owner fixes both gaps.
let ACTIVE_MAINNET_ADDRESS = PINNED_ACTIVE_COIN_OWNER;
const BACKUP_MAINNET_ADDRESS = PINNED_ACTIVE_COIN_OWNER;

beforeAll(async () => {
  ACTIVE_MAINNET_ADDRESS = await discoverActiveCoinOwner();
}, 30_000);

function isWellShaped(e: ActivityEntry): void {
  expect(typeof e.digest).toBe("string");
  expect(e.digest.length).toBeGreaterThan(0);
  expect(typeof e.timestampMs).toBe("number");
  expect([
    "sent",
    "received",
    "invest",
    "withdraw",
    "swap",
    "autoswap",
  ]).toContain(e.direction);
  // amountUsdsui / amountSui are nullable numbers
  expect(e.amountUsdsui === null || typeof e.amountUsdsui === "number").toBe(
    true
  );
  expect(e.amountSui === null || typeof e.amountSui === "number").toBe(true);
  // counterparty is nullable string
  expect(e.counterparty === null || typeof e.counterparty === "string").toBe(
    true
  );
  // counterpartyName is nullable string
  expect(
    e.counterpartyName === null || typeof e.counterpartyName === "string"
  ).toBe(true);
  // venue / roundupUsdsui / otherCoin are nullable
  expect(e.venue === null || typeof e.venue === "string").toBe(true);
  expect(
    e.roundupUsdsui === null || typeof e.roundupUsdsui === "number"
  ).toBe(true);
  if (e.otherCoin !== null) {
    expect(typeof e.otherCoin.coinType).toBe("string");
    expect(typeof e.otherCoin.symbol).toBe("string");
    expect(typeof e.otherCoin.amount).toBe("string");
    expect(typeof e.otherCoin.decimals).toBe("number");
  }
}

describe("getRecentActivity (GraphQL)", () => {
  it("returns a well-shaped, sorted, deduped, NON-EMPTY feed for an active mainnet address", async () => {
    // limit=10 → fetchLimit=50 → exactly ONE GraphQL page, which stays
    // comfortably under `getRecentActivity`'s 6s tx-history timeout fence.
    // (limit=50 would fan out to 4 serial pages ~8s and trip the fence,
    // returning [] — that masked real parsing regressions before.)
    let entries = await getRecentActivity(ACTIVE_MAINNET_ADDRESS, 10, {
      includeNonTalise: true,
      vaultId: null,
    });
    if (entries.length === 0) {
      entries = await getRecentActivity(BACKUP_MAINNET_ADDRESS, 10, {
        includeNonTalise: true,
        vaultId: null,
      });
    }

    // Always-true: result is an array of ActivityEntry shape.
    expect(Array.isArray(entries)).toBe(true);

    // The whole point: a genuinely active address must yield real rows.
    // This is what actually exercises the GraphQL → adapter → classifier
    // pipeline with live data. (0x2/0x6 framework objects had ZERO
    // owner-side balance deltas and produced an empty feed — a vacuous
    // pass — which is why this fixture is a real coin-owning address.)
    expect(entries.length).toBeGreaterThan(0);

    // Shape check on every row.
    for (const e of entries) isWellShaped(e);

    // At least one row must carry a concrete amount on SOME tracked asset
    // (USDsui, SUI, or another coin) — proves the balance-change parse +
    // coin-type normalization landed (pre-fix, native SUI/USDsui deltas
    // were silently dropped by a short-vs-full type-string mismatch).
    const hasAmount = entries.some(
      (e) =>
        e.amountUsdsui !== null ||
        e.amountSui !== null ||
        e.otherCoin !== null
    );
    expect(hasAmount).toBe(true);

    // Sorted newest first.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].timestampMs).toBeLessThanOrEqual(
        entries[i - 1].timestampMs
      );
    }

    // Digests are unique (dedupe worked).
    const digests = new Set(entries.map((e) => e.digest));
    expect(digests.size).toBe(entries.length);

    // Within the requested limit.
    expect(entries.length).toBeLessThanOrEqual(10);
  }, 30_000);

  it("tolerates an address with no activity (returns []), without throwing", async () => {
    // A random, well-formed but unused address — pulled from the Sui
    // address space at random; verified zero history via mainnet
    // GraphQL on 2026-05-29 (the previous fixture, `0x…beef`, picked
    // up a real on-chain tx and started failing this assertion).
    // Confirms the GraphQL query handles the empty page case cleanly.
    const unusedAddress =
      "0x7b6e4e5a8f3c2d1b0a9988776655443322110011223344556677889900aabbcc";
    const entries = await getRecentActivity(unusedAddress, 20, {
      includeNonTalise: true,
      vaultId: null,
    });
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBe(0);
  }, 30_000);

  // ---------------------------------------------------------------------
  // Sub-plan 4.6 — deeper assertions on the classifier output.
  //
  // We share a single fetched feed across these cases (via a lazy
  // promise) so the test file makes ONE network round-trip for the
  // populated-feed cases below instead of N. Vitest runs `it`s
  // sequentially inside a `describe`, so this is safe.
  // ---------------------------------------------------------------------

  /**
   * Lazily fetch a populated feed for the active address. limit=10 keeps
   * the walk to a SINGLE GraphQL page (fetchLimit=50) so it stays under
   * the 6s tx-history timeout fence — an active address with 50 rows in
   * one page reliably surfaces multiple `direction` values. Falls back to
   * the backup address if the primary returns empty.
   */
  let cached: ActivityEntry[] | undefined;
  async function getPopulatedFeed(): Promise<ActivityEntry[]> {
    if (cached) return cached;
    let entries = await getRecentActivity(ACTIVE_MAINNET_ADDRESS, 10, {
      includeNonTalise: true,
      vaultId: null,
    });
    if (entries.length === 0) {
      entries = await getRecentActivity(BACKUP_MAINNET_ADDRESS, 10, {
        includeNonTalise: true,
        vaultId: null,
      });
    }
    cached = entries;
    return entries;
  }

  it("orders entries strictly descending by timestampMs", async () => {
    // Reaffirmed here separately from the existing shape test so a
    // regression in the merge/sort step is obvious from the failing
    // test name. The classifier's final pass does:
    //   entries.sort((a, b) => b.timestampMs - a.timestampMs)
    // followed by a single-pass dedupe — both of which need to
    // preserve descending order.
    const entries = await getPopulatedFeed();
    if (entries.length < 2) return; // active address went silent — nothing to assert
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].timestampMs).toBeLessThanOrEqual(
        entries[i - 1].timestampMs
      );
    }
  }, 30_000);

  it("deduplicates by digest — no two entries share the same digest", async () => {
    // The merge pass uses a Map keyed by digest with a vault-row
    // preference. After the pass, the resulting array MUST have
    // unique digests even when wallet + vault sides surface the same
    // tx (e.g. a vault auto-swap that also touches the user's
    // address as a fee rebate).
    const entries = await getPopulatedFeed();
    const digests = entries.map((e) => e.digest);
    const unique = new Set(digests);
    expect(unique.size).toBe(digests.length);
  }, 30_000);

  it("assigns every row a recognized direction (classifier ran on real data)", async () => {
    // Every row in a populated feed must carry a VALID, recognized
    // direction — proving the classifier actually ran over real,
    // adapter-normalized tx data rather than crashing or emitting a bogus
    // label. We deliberately do NOT require two distinct kinds: a
    // dynamically-discovered active address can legitimately be a
    // single-purpose actor (e.g. a swap bot whose recent window is all
    // "swap", or a faucet that's all "sent"), so a strict ">=2 kinds"
    // assertion would be flaky against live data. The real regression we
    // guard is "did classification produce sane output for every row".
    const VALID = new Set([
      "sent",
      "received",
      "invest",
      "withdraw",
      "swap",
      "autoswap",
    ]);
    const entries = await getPopulatedFeed();
    if (entries.length === 0) return; // discovered address went quiet
    for (const e of entries) {
      expect(VALID.has(e.direction)).toBe(true);
      // And every classified row carries a concrete amount on SOME asset.
      expect(
        e.amountUsdsui !== null ||
          e.amountSui !== null ||
          e.otherCoin !== null
      ).toBe(true);
    }
  }, 30_000);

  it("collapses compound spend+save into one row carrying both legs", async () => {
    // The classifier documents (see `activity.ts` comments):
    //
    //   When a Send PTB included a round-up NAVI supply leg (Phase 2
    //   v2), the tx digest has BOTH a `send` and an `invest` PK
    //   PaymentRecord. We collapse them into ONE activity row —
    //   `direction: "sent"`, `amountUsdsui` = the send leg, and
    //   `roundupUsdsui` = the auto-saved portion.
    //
    // So the contract under test is: NEVER two separate entries with
    // the same digest for a spend+save tx — they merge into one.
    // Whenever an entry has `roundupUsdsui != null`, its `direction`
    // must be "sent" and the row must be the SOLE row for that
    // digest (the dedup assertion above already enforces uniqueness
    // globally, but we re-affirm here in the context of the
    // compound contract).
    const entries = await getPopulatedFeed();
    const compound = entries.filter((e) => e.roundupUsdsui !== null);
    for (const row of compound) {
      expect(row.direction).toBe("sent");
      // Both numbers should be present + positive when the merge ran.
      expect(typeof row.amountUsdsui).toBe("number");
      expect(row.amountUsdsui).toBeGreaterThan(0);
      expect(row.roundupUsdsui).toBeGreaterThan(0);
      // The compound row should be uniquely identified by its digest.
      const sameDigest = entries.filter((e) => e.digest === row.digest);
      expect(sameDigest.length).toBe(1);
    }
  }, 30_000);

  it("respects the requested limit", async () => {
    // Final guard: even on an extremely active address the function
    // must never return more rows than the caller asked for. The
    // classifier slices to `limit` after the merge.
    const entries = await getRecentActivity(ACTIVE_MAINNET_ADDRESS, 5, {
      includeNonTalise: true,
      vaultId: null,
    });
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeLessThanOrEqual(5);
  }, 30_000);

  // ---------------------------------------------------------------------
  // Raw GraphQL activity-query + pagination shape.
  //
  // Exercises the underlying `transactions(filter: { affectedAddress })`
  // query (the exact query `getRecentActivity` walks) directly against
  // mainnet, asserting the page shape AND that cursor pagination advances
  // to a DIFFERENT, non-overlapping page. This is the lower-level proof
  // that the GraphQL read path the activity feed depends on is correct.
  // ---------------------------------------------------------------------
  it("batchCoinMetadata resolves REAL on-chain metadata (endpoint live)", async () => {
    // Regression guard for the dead GraphQL endpoint: the fetch-layer
    // default used to point at the retired `sui-mainnet.mystenlabs.com`
    // host, which `fetch failed` — `batchCoinMetadata` then silently fell
    // through to its catch and returned a type-string-derived symbol with
    // a DEFAULT 9 decimals for EVERY coin. Now that the endpoint is live,
    // we must get the canonical CoinMetadata back from the chain.
    _clearGraphQLCache();
    const SUI = "0x2::sui::SUI";
    const USDC =
      "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
    const out = await batchCoinMetadata([SUI, USDC]);

    const sui = out.get(SUI);
    expect(sui).toBeDefined();
    expect(sui!.symbol).toBe("SUI");
    expect(sui!.decimals).toBe(9);

    // USDC is 6-decimals on Sui — if we were still hitting the dead
    // endpoint this would be the fallback 9. Asserting 6 proves the
    // live `coinMetadata(coinType:)` query actually answered.
    const usdc = out.get(USDC);
    expect(usdc).toBeDefined();
    expect(usdc!.symbol).toBe("USDC");
    expect(usdc!.decimals).toBe(6);
  }, 30_000);

  it("activity GraphQL query returns a well-formed, advancing page", async () => {
    const PAGE_QUERY = /* GraphQL */ `
      query ActivityPage($addr: SuiAddress!, $first: Int!, $after: String) {
        transactions(
          filter: { affectedAddress: $addr }
          first: $first
          after: $after
        ) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            digest
            effects {
              status
              timestamp
              balanceChangesJson
            }
          }
        }
      }
    `;
    const client = suiGraphQL();
    const page1 = (await client.query({
      query: PAGE_QUERY,
      variables: { addr: ACTIVE_MAINNET_ADDRESS, first: 5, after: null },
    })) as {
      data?: {
        transactions?: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            digest: string;
            effects: {
              status: string | null;
              timestamp: string | null;
              balanceChangesJson: unknown | null;
            } | null;
          }>;
        };
      };
      errors?: unknown;
    };

    // No GraphQL errors, and the page is well-shaped.
    expect(page1.errors).toBeUndefined();
    const t1 = page1.data?.transactions;
    expect(t1).toBeDefined();
    expect(Array.isArray(t1?.nodes)).toBe(true);
    expect(typeof t1?.pageInfo.hasNextPage).toBe("boolean");
    expect(t1!.nodes.length).toBeGreaterThan(0);

    // Each node carries the fields `adaptGraphQLNodeToRawTx` consumes.
    for (const n of t1!.nodes) {
      expect(typeof n.digest).toBe("string");
      expect(n.digest.length).toBeGreaterThan(0);
      expect(n.effects).toBeDefined();
      // balanceChangesJson is the load-bearing field for amount parsing.
      expect(Array.isArray(n.effects?.balanceChangesJson)).toBe(true);
    }

    // Pagination shape holds: when there's a next page, the cursor is a
    // non-empty string and the next page is DISJOINT from the first.
    if (t1!.pageInfo.hasNextPage) {
      expect(typeof t1!.pageInfo.endCursor).toBe("string");
      expect((t1!.pageInfo.endCursor ?? "").length).toBeGreaterThan(0);

      const page2 = (await client.query({
        query: PAGE_QUERY,
        variables: {
          addr: ACTIVE_MAINNET_ADDRESS,
          first: 5,
          after: t1!.pageInfo.endCursor,
        },
      })) as typeof page1;
      const t2 = page2.data?.transactions;
      expect(t2).toBeDefined();
      const firstDigests = new Set(t1!.nodes.map((n) => n.digest));
      for (const n of t2!.nodes ?? []) {
        expect(firstDigests.has(n.digest)).toBe(false);
      }
    }
  }, 30_000);
});
