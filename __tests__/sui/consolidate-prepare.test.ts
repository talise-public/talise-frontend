/**
 * Integration test for `/api/wallet/consolidate-prepare` — the one-time
 * "Enable gasless balance" route. Mirrors the auth + module-mock pattern
 * used by `send-sponsored.test.ts` so the assertions cover the route's
 * branching without spinning up a live Sui/Onara stack.
 *
 * Scope: PREPARE only. We never sign, submit, or broadcast a tx. The
 * test exercises the route handler against mocked `listCoins`,
 * `getObject`, `onara.status()`, and `getReferenceGasPrice` outputs.
 *
 * Branches asserted:
 *   1. N Coin<USDsui> objects + all valid → `mode: "consolidation"`,
 *      `coinCount === N`, `totalMicrosMoved === sum of balances`,
 *      `bytes` is a non-empty base64 string, and the stubbed
 *      Transaction received exactly 2*N moveCalls (one into_balance
 *      + one send_funds per coin).
 *   2. Accumulator-shadow filtering — a candidate whose getObject
 *      lookup throws (or returns a non-Coin type) is DROPPED. We
 *      assert the moveCall count reflects the dropped count, not the
 *      raw listCoins count.
 *   3. Zero valid coins → 200 `{ alreadyGasless: true }` with no
 *      bytes — the no-op path.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fromBase64 } from "@mysten/sui/utils";

// ─── Hoisted mocks ──────────────────────────────────────────────────

vi.mock("@/lib/mobile-sessions", () => ({
  readEntryIdFromRequest: vi.fn(async () => 42),
  isMobileRequest: vi.fn(() => true),
}));

vi.mock("@/lib/db", () => ({
  userById: vi.fn(async () => ({
    id: 42,
    google_sub: "test-sub",
    email: "test@example.com",
    name: "Test User",
    picture: null,
    sui_address:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    salt: "0",
    country: null,
    created_at: 0,
    last_seen_at: 0,
    notified_at: null,
    account_type: "personal",
    business_name: null,
    business_handle: null,
    business_industry: null,
    talise_username: null,
    roundup_enabled: 0,
    roundup_percentage: 5,
  })),
}));

vi.mock("@/lib/onara", () => ({
  onara: () => ({
    status: async () => ({
      address:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
    }),
  }),
}));

vi.mock("@/lib/perf-cache", () => ({
  memoTtl: <T,>(_k: string, _ttl: number, fn: () => Promise<T>) => fn(),
}));

// The Sui client: only `listCoins`, `getObject`, and
// `getReferenceGasPrice` are exercised here. We swap their return
// values per-test via `vi.mocked(...).mockResolvedValue(...)` so each
// branch reads the shape it expects.
//
// Note: the route normalises the expected object type to lowercase
// before comparing, so the mocked `objectType` here uses lowercase to
// match (USDSUI_TYPE in usdsui.ts is also lowercase address+module).
const USDSUI_TYPE =
  "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const COIN_TYPE = `0x2::coin::Coin<${USDSUI_TYPE}>`;

const listCoinsMock = vi.fn();
const getObjectMock = vi.fn();
// The route now reads the Address Balance accumulator via
// `client.getBalance({owner, coinType})` to power the two-signal
// shadow filter. These tests filter the shadow through the getObject
// cross-check instead (coins carry no version, so the balance-match
// signal never fires), so a zero accumulator is the safe default.
const getBalanceMock = vi.fn(async () => ({
  balance: { addressBalance: "0", coinBalance: "0", balance: "0", coinType: "" },
}));

vi.mock("@/lib/sui", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sui")>(
    "@/lib/sui"
  );
  return {
    ...actual,
    sui: () => ({
      getBalance: getBalanceMock,
      listCoins: listCoinsMock,
      getObject: getObjectMock,
      getReferenceGasPrice: async () => ({ referenceGasPrice: "1000" }),
    }),
    network: () => "mainnet" as const,
  };
});

// Stub Transaction so `tx.build({ client })` returns a deterministic
// non-empty buffer. We also count moveCalls so we can assert the PTB
// shape (2 per surviving coin: into_balance + send_funds).
let moveCallCount = 0;
vi.mock("@mysten/sui/transactions", async () => {
  const actual = await vi.importActual<typeof import("@mysten/sui/transactions")>(
    "@mysten/sui/transactions"
  );
  class StubTransaction {
    setSender = vi.fn();
    setGasOwner = vi.fn();
    setGasPrice = vi.fn();
    setGasBudget = vi.fn();
    object = vi.fn(() => ({ kind: "Input" }));
    pure = {
      address: vi.fn(() => ({ kind: "Input" })),
    };
    moveCall = vi.fn(() => {
      moveCallCount += 1;
      return { kind: "Result" };
    });
    build = vi.fn(async () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  }
  return {
    ...actual,
    Transaction: StubTransaction,
  };
});

// ─── Import AFTER mocks so the route resolves them ─────────────────
const { POST } = await import("@/app/api/wallet/consolidate-prepare/route");

function buildReq(body: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/api/wallet/consolidate-prepare", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify(body),
  });
}

describe("/api/wallet/consolidate-prepare", () => {
  beforeEach(() => {
    process.env.ONARA_URL = "http://onara.test";
    vi.clearAllMocks();
    moveCallCount = 0;
  });

  it("builds the consolidation PTB with one into_balance + one send_funds per Coin object", async () => {
    // Three real Coin<USDsui> objects with mixed balances. Each will
    // produce exactly two moveCalls (into_balance + send_funds) — so
    // the expected total is 6 moveCalls and totalMicrosMoved is the
    // sum.
    listCoinsMock.mockResolvedValue({
      objects: [
        { objectId: "0xa11", balance: "100000", type: COIN_TYPE },
        { objectId: "0xa12", balance: "266000", type: COIN_TYPE },
        { objectId: "0xa13", balance: "300928", type: COIN_TYPE },
      ],
      cursor: null,
      hasNextPage: false,
    });
    getObjectMock.mockImplementation(async ({ objectId }: { objectId: string }) => ({
      object: { objectId, objectType: COIN_TYPE },
    }));

    const res = await POST(buildReq({ asset: "USDsui" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      bytes: string;
      mode: string;
      coinCount: number;
      totalMicrosMoved: string;
      alreadyGasless?: boolean;
    };

    expect(json.mode).toBe("consolidation");
    expect(json.coinCount).toBe(3);
    expect(json.totalMicrosMoved).toBe(String(100000 + 266000 + 300928));
    expect(json.alreadyGasless).toBeUndefined();
    expect(typeof json.bytes).toBe("string");
    expect(json.bytes.length).toBeGreaterThan(0);
    expect(fromBase64(json.bytes).length).toBeGreaterThan(0);

    // 2 moveCalls per surviving coin × 3 coins = 6.
    expect(moveCallCount).toBe(6);
  });

  it("drops the accumulator-shadow object (getObject throws or wrong type) and consolidates only the real Coins", async () => {
    // listCoins returns four candidates. The route must filter:
    //   - 0xa11: real Coin → kept
    //   - 0xa12: getObject throws (looks like accumulator shadow) → dropped
    //   - 0xa13: getObject returns wrong object type → dropped
    //   - 0xa14: real Coin → kept
    listCoinsMock.mockResolvedValue({
      objects: [
        { objectId: "0xa11", balance: "100000", type: COIN_TYPE },
        { objectId: "0xa12", balance: "3788", type: COIN_TYPE },
        { objectId: "0xa13", balance: "999999", type: COIN_TYPE },
        { objectId: "0xa14", balance: "200000", type: COIN_TYPE },
      ],
      cursor: null,
      hasNextPage: false,
    });
    getObjectMock.mockImplementation(async ({ objectId }: { objectId: string }) => {
      if (objectId === "0xa12") {
        throw new Error("Object 0xa12 not found");
      }
      if (objectId === "0xa13") {
        // Wrong type — simulates the accumulator-shadow's read-only
        // surface object that masquerades under suix_getCoins but
        // is NOT a transferable Coin<T> on chain.
        return { object: { objectId, objectType: "0x2::accumulator::Shadow" } };
      }
      return { object: { objectId, objectType: COIN_TYPE } };
    });

    const res = await POST(buildReq({ asset: "USDsui" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      mode: string;
      coinCount: number;
      totalMicrosMoved: string;
    };

    // Only 0xa11 + 0xa14 survive: 2 valid coins, sum = 100k + 200k.
    expect(json.mode).toBe("consolidation");
    expect(json.coinCount).toBe(2);
    expect(json.totalMicrosMoved).toBe(String(100000 + 200000));
    // 2 moveCalls per surviving coin × 2 coins = 4.
    expect(moveCallCount).toBe(4);
  });

  it("returns alreadyGasless when the user holds zero real Coin<USDsui> objects (already on accumulator)", async () => {
    // Either listCoins returns nothing, or everything it returned was
    // filtered out by the getObject cross-check. Both paths produce
    // the same 200 response.
    listCoinsMock.mockResolvedValue({
      objects: [],
      cursor: null,
      hasNextPage: false,
    });

    const res = await POST(buildReq({ asset: "USDsui" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      alreadyGasless: boolean;
      mode: string;
      coinCount: number;
      totalMicrosMoved: string;
      bytes?: string;
    };

    expect(json.alreadyGasless).toBe(true);
    expect(json.coinCount).toBe(0);
    expect(json.totalMicrosMoved).toBe("0");
    expect(json.bytes).toBeUndefined();
    // No moveCalls — we never even built a PTB.
    expect(moveCallCount).toBe(0);
  });
});
