/**
 * Integration test for `/api/swap/prepare` — the fused sponsor-prepare
 * swap endpoint that converts non-USDsui Coin<T> in a user's wallet into
 * USDsui via DeepBook v3, with Onara picking up gas.
 *
 * Scope: PREPARE only. No tx is signed or broadcast. Everything heavy
 * (Sui client, Onara, DeepBook quote sim, Transaction.build) is stubbed
 * at module-load time. Mirrors the pattern used by
 * `send-sponsored.test.ts` and `consolidate-prepare.test.ts`.
 *
 * Assertions (one test, multiple expects):
 *   1. Route returns `mode: "sponsored-swap"`.
 *   2. PTB has ≥ 1 MoveCall captured (DeepBook swap_exact_*).
 *   3. Sponsor address is set via `tx.setGasOwner(sponsor)` (we assert
 *      the call was made with the mocked sponsor address).
 *   4. Gas price is set via `tx.setGasPrice(gasPrice)` (we assert the
 *      call was made with the mocked BigInt gas price).
 *   5. Response surfaces `from`, `to: USDSUI_TYPE`, `fromMicros`, and
 *      `estimatedToMicros` — the fields iOS reads to render the
 *      "you'll receive ~$X" preview.
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
    roundup_percentage: 0,
  })),
}));

const SPONSOR_ADDR =
  "0x2222222222222222222222222222222222222222222222222222222222222222";

vi.mock("@/lib/onara", () => ({
  onara: () => ({
    status: async () => ({ address: SPONSOR_ADDR }),
  }),
}));

vi.mock("@/lib/perf-cache", () => ({
  memoTtl: <T,>(_k: string, _ttl: number, fn: () => Promise<T>) => fn(),
  invalidate: vi.fn(),
  recordSendLatency: vi.fn(),
  readSendLatencySamples: vi.fn(() => []),
  setPendingRoundup: vi.fn(),
  takePendingRoundup: vi.fn(() => null),
}));

// Sui client stub — only `getReferenceGasPrice` is reached on the
// prepare path (`tx.build` is stubbed below).
vi.mock("@/lib/sui", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/sui")>("@/lib/sui");
  return {
    ...actual,
    sui: () => ({
      getReferenceGasPrice: async () => ({ referenceGasPrice: "1000" }),
    }),
    network: () => "mainnet" as const,
  };
});

// DeepBook SDK stub. The route constructs a DeepBookClient and calls:
//   - getQuoteQuantityOut / getBaseQuantityOut (for the slippage quote)
//   - deepBook.swapExactBaseForQuote / swapExactQuoteForBase (PTB shape)
// We stub both surfaces. The swap helper returns a thunk that, when
// called with `(tx)`, appends a moveCall via `tx.moveCall` and returns
// a triple of `[base, quote, deep]` argument-shaped values for the
// route to wire into `transferObjects`.
vi.mock("@mysten/deepbook-v3", () => {
  class StubDeepBookClient {
    constructor(_opts: unknown) {}
    async getQuoteQuantityOut(_pk: string, baseQty: number) {
      // Round-trip identity for the test — 1 SUI ≈ 2 USDSUI to make
      // estimatedToMicros visibly differ from fromMicros.
      return {
        baseQuantity: baseQty,
        baseOut: 0,
        quoteOut: baseQty * 2,
        deepRequired: 0,
      };
    }
    async getBaseQuantityOut(_pk: string, quoteQty: number) {
      return {
        quoteQuantity: quoteQty,
        baseOut: quoteQty * 2,
        quoteOut: 0,
        deepRequired: 0,
      };
    }
    deepBook = {
      swapExactBaseForQuote:
        (_p: unknown) => (tx: { moveCall: (m: unknown) => unknown }) => {
          tx.moveCall({
            target: "0xDB::pool::swap_exact_base_for_quote",
          });
          return [
            { kind: "Result", index: 0 },
            { kind: "Result", index: 1 },
            { kind: "Result", index: 2 },
          ] as const;
        },
      swapExactQuoteForBase:
        (_p: unknown) => (tx: { moveCall: (m: unknown) => unknown }) => {
          tx.moveCall({
            target: "0xDB::pool::swap_exact_quote_for_base",
          });
          return [
            { kind: "Result", index: 0 },
            { kind: "Result", index: 1 },
            { kind: "Result", index: 2 },
          ] as const;
        },
    };
  }
  return { DeepBookClient: StubDeepBookClient };
});

// ─── Transaction stub ────────────────────────────────────────────────
// We track moveCall invocations, the sponsor address argument to
// setGasOwner, and the gasPrice argument to setGasPrice — these are
// the contract bits the test asserts on.
const txState = {
  moveCalls: [] as Array<{ target?: string }>,
  gasOwner: null as string | null,
  gasPrice: null as bigint | null,
  sender: null as string | null,
};

vi.mock("@mysten/sui/transactions", async () => {
  const actual = await vi.importActual<
    typeof import("@mysten/sui/transactions")
  >("@mysten/sui/transactions");
  class StubTransaction {
    setSender = vi.fn((s: string) => {
      txState.sender = s;
    });
    setGasOwner = vi.fn((s: string) => {
      txState.gasOwner = s;
    });
    setGasPrice = vi.fn((p: bigint) => {
      txState.gasPrice = p;
    });
    setGasBudget = vi.fn();
    setGasBudgetIfNotSet = vi.fn();
    setSenderIfNotSet = vi.fn();
    add = vi.fn(() => ({ kind: "Result" }));
    moveCall = vi.fn((m: { target?: string }) => {
      txState.moveCalls.push(m);
      return [
        { kind: "Result", index: 0 },
        { kind: "Result", index: 1 },
        { kind: "Result", index: 2 },
      ];
    });
    transferObjects = vi.fn();
    object = vi.fn(() => ({ kind: "Input" }));
    pure = {
      address: vi.fn(() => ({ kind: "Input" })),
      u64: vi.fn(() => ({ kind: "Input" })),
    };
    build = vi.fn(async () => {
      return new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    });
  }
  return {
    ...actual,
    Transaction: StubTransaction,
    coinWithBalance: vi.fn(() => ({ kind: "TxIntent" })),
  };
});

// ─── Import AFTER mocks ──────────────────────────────────────────────
const { POST } = await import("@/app/api/swap/prepare/route");
const { USDSUI_TYPE } = await import("@/lib/usdsui");
const { COIN_TYPES } = await import("@/lib/sui");

function buildReq(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/swap/prepare", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify(body),
  });
}

describe("/api/swap/prepare (sponsored-swap, PREPARE only)", () => {
  beforeEach(() => {
    process.env.ONARA_URL = "http://onara.test";
    txState.moveCalls.length = 0;
    txState.gasOwner = null;
    txState.gasPrice = null;
    txState.sender = null;
    vi.clearAllMocks();
  });

  it("SUI → USDsui returns mode:'sponsored-swap' with sponsor + gasPrice + ≥1 swap MoveCall", async () => {
    const fromMicros = "1000000000"; // 1 SUI
    const res = await POST(
      buildReq({
        fromCoinType: COIN_TYPES.SUI,
        fromAmountMicros: fromMicros,
      })
    );
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      bytes: string;
      mode: string;
      from: string;
      to: string;
      fromMicros: string;
      estimatedToMicros: string;
      sponsor: string;
      gasPrice: string;
    };

    // (1) Mode label is the canonical sponsored-swap.
    expect(json.mode).toBe("sponsored-swap");

    // (5) Response surfaces the fields iOS needs.
    expect(json.from).toBe(COIN_TYPES.SUI);
    expect(json.to).toBe(USDSUI_TYPE);
    expect(json.fromMicros).toBe(fromMicros);
    expect(json.sponsor).toBe(SPONSOR_ADDR);
    expect(json.gasPrice).toBe("1000");
    // estimatedToMicros is non-empty u64 string > 0.
    expect(BigInt(json.estimatedToMicros) > 0n).toBe(true);

    // Bytes round-trip.
    const decoded = fromBase64(json.bytes);
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(decoded.length).toBeGreaterThan(0);

    // (2) PTB has ≥ 1 DeepBook swap MoveCall.
    expect(txState.moveCalls.length).toBeGreaterThanOrEqual(1);
    expect(
      txState.moveCalls.some((m) =>
        (m.target ?? "").includes("swap_exact")
      )
    ).toBe(true);

    // (3) sponsor address landed on setGasOwner.
    expect(txState.gasOwner).toBe(SPONSOR_ADDR);

    // (4) gas price landed on setGasPrice (BigInt(1000)).
    expect(txState.gasPrice).toBe(1000n);

    // Sanity: sender is the user.
    expect(txState.sender).toBe(
      "0x1111111111111111111111111111111111111111111111111111111111111111"
    );
  });
});
