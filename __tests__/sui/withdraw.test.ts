/**
 * Integration test for `POST /api/earn/withdraw/prepare` — NAVI leg.
 *
 * Scope: PREPARE only. We do NOT submit a transaction. We assert the
 * route returns a sponsored-ready transactionKindB64 whose bytes decode
 * to a non-empty Uint8Array, and that bad inputs return 400 cleanly.
 *
 * Auth: the route reads `userId` via `readEntryIdFromRequest`, then
 * loads the user via `userById`. We mock both modules so the test
 * doesn't need a real bearer or a populated database — every other
 * sub-plan-4.x test in this repo follows the same vi.mock pattern (see
 * `harness.ts`'s comment about real-mainnet reads being limited to
 * read-only assertions; build tests stub at the auth boundary).
 *
 * NAVI dependency: `appendNaviWithdraw` would normally call out to the
 * NAVI adapter (Pyth + position lookup against mainnet). We don't want
 * that network roundtrip in a unit-shaped test, so we stub the navi
 * supply lib too — the assertion target is the route's wiring, not
 * NAVI's adapter (which has its own coverage).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";

// ─── Mocks (declared before the route import so vi.mock is hoisted) ──

vi.mock("@/lib/mobile-sessions", () => ({
  readEntryIdFromRequest: vi.fn(async () => 1),
  isMobileRequest: vi.fn(() => true),
}));

vi.mock("@/lib/db", () => ({
  userById: vi.fn(async (_id: number) => ({
    id: 1,
    google_sub: "test-sub",
    email: "withdraw-test@talise.local",
    name: "Withdraw Test",
    picture: null,
    // Well-formed mainnet-style address (any 0x + 64 hex chars works for PTB
    // build, which doesn't validate against on-chain state).
    sui_address:
      "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29",
    salt: "1",
    country: "US",
    created_at: 0,
    last_seen_at: 0,
  })),
}));

// Stub NAVI: have `appendNaviWithdraw` append a single trivial MoveCall
// so the resulting Transaction has at least one command. Tracks the
// requested withdraw amount so per-test logic can branch on "withdraw
// more than supplied" without round-tripping to mainnet.
let lastRequestedAmount: number | undefined = undefined;
let suppliedBalance = 100; // pretend the user has 100 USDsui supplied
let simulateOverdraw = false;

vi.mock("@/lib/navi-supply", () => ({
  appendNaviWithdraw: vi.fn(
    async (tx: Transaction, _sender: string, amount: number | undefined) => {
      lastRequestedAmount = amount;
      if (simulateOverdraw && amount !== undefined && amount > suppliedBalance) {
        // Mirror the real NaviAdapter behaviour: it throws if the user
        // tries to withdraw more than their supplied balance during the
        // position-health check it does internally.
        throw new Error(
          `requested ${amount} > supplied ${suppliedBalance}: no NAVI USDsui position covers this withdraw`
        );
      }
      // Append a harmless MoveCall so the built PTB has a command.
      tx.moveCall({
        target: "0x2::clock::timestamp_ms",
        arguments: [tx.object("0x6")],
      });
    }
  ),
}));

// DeepBook venue isn't exercised here but the route imports it at the
// top level — stub so the module loads without touching mainnet.
vi.mock("@/lib/deepbook-margin", () => ({
  fetchSupplierCapId: vi.fn(async () => null),
  buildWithdrawUsdsuiMargin: vi.fn(() => ({ build: (_: Transaction) => {} })),
  buildSupplyUsdsuiMargin: vi.fn(() => ({ build: (_: Transaction) => {} })),
}));

// Payment-kit receipt — append a no-op so the route's
// `appendPaymentKitReceipt(...)` call works without onchain state.
vi.mock("@/lib/intents/wrap-payment-kit", () => ({
  appendPaymentKitReceipt: vi.fn(() => ({
    nonce: "test-nonce-" + Math.random().toString(16).slice(2),
  })),
}));

// ─── Imports under test (after mocks) ───────────────────────────────

// Late-imported via dynamic import inside each test so the vi.mock
// declarations above are guaranteed to be applied before the route
// module evaluates its top-level imports.
async function postWithdraw(body: unknown): Promise<Response> {
  const { POST } = await import("@/app/api/earn/withdraw/prepare/route");
  return POST(
    new Request("http://test.local/api/earn/withdraw/prepare", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-token",
      },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /api/earn/withdraw/prepare (NAVI)", () => {
  beforeEach(() => {
    lastRequestedAmount = undefined;
    simulateOverdraw = false;
    suppliedBalance = 100;
  });

  it("returns transactionKindB64 for a valid NAVI partial withdraw", async () => {
    const res = await postWithdraw({ venue: "navi", amount: 10 });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      transactionKindB64: string;
      venue: string;
      amount: number | null;
      withdrawAll: boolean;
    };
    expect(typeof json.transactionKindB64).toBe("string");
    expect(json.transactionKindB64.length).toBeGreaterThan(0);
    expect(json.venue).toBe("navi");
    expect(json.amount).toBe(10);
    expect(json.withdrawAll).toBe(false);
    expect(lastRequestedAmount).toBe(10);
  });

  it("decodes transactionKindB64 to a non-empty Uint8Array", async () => {
    const res = await postWithdraw({ venue: "navi", amount: 5 });
    expect(res.status).toBe(200);
    const { transactionKindB64 } = (await res.json()) as {
      transactionKindB64: string;
    };
    const bytes = fromBase64(transactionKindB64);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("treats missing/zero amount as full withdraw (passes undefined to adapter)", async () => {
    const res = await postWithdraw({ venue: "navi" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { withdrawAll: boolean; amount: null };
    expect(json.withdrawAll).toBe(true);
    expect(json.amount).toBeNull();
    // The route forwards `undefined` to `appendNaviWithdraw` for the
    // "withdraw all" case so the adapter resolves the live balance.
    expect(lastRequestedAmount).toBeUndefined();
  });

  // ─── Invalid input → 400 ─────────────────────────────────────────

  it("rejects an unsupported venue with 400", async () => {
    const res = await postWithdraw({ venue: "ponzi", amount: 10 });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/venue must be one of/);
  });

  it("rejects a negative amount with 400", async () => {
    const res = await postWithdraw({ venue: "navi", amount: -1 });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/non-negative/);
  });

  it("rejects a non-numeric amount with 400", async () => {
    const res = await postWithdraw({ venue: "navi", amount: "not-a-number" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/non-negative/);
  });

  // ─── Over-withdraw behaviour ─────────────────────────────────────
  //
  // Documented behaviour: PREPARE is purely a PTB build step — it does
  // NOT inspect the user's live supplied balance. If a user requests
  // more than they've supplied, one of three things happens:
  //
  //   (a) The NaviAdapter throws synchronously during build (it does
  //       its own position-health check internally for some inputs).
  //       The NAVI append is wrapped in `withTimeout`, which now
  //       distinguishes a thrown adapter error (`kind:"error"`) from a
  //       wedged RPC (`kind:"timeout"`): the former surfaces as a 502
  //       NAVI_WITHDRAW_FAILED with the real reason ("no NAVI position
  //       covers this withdraw"), the latter as a 504 "try again".
  //   (b) Build succeeds and the chain rejects the actual withdraw at
  //       submit time (MoveAbort from NAVI's withdraw entry).
  //
  // The route can't tell these apart in advance — all three are valid
  // outcomes depending on what data NAVI has cached in its adapter
  // when build runs.

  it("over-withdraw: fails fast (502 NAVI_WITHDRAW_FAILED or 504 timeout) or succeeds at PREPARE (chain rejects at submit)", async () => {
    simulateOverdraw = true;
    suppliedBalance = 50;

    const res = await postWithdraw({ venue: "navi", amount: 1_000_000 });

    if (res.status === 504) {
      // (a-timeout) RPC wedged → user-friendly 504.
      const json = (await res.json()) as { error: string };
      expect(json.error).toMatch(/responding slowly|longer than usual/i);
    } else if (res.status === 502) {
      // (a-error) Adapter rejected the over-withdraw → fail-fast 502
      // carrying the real NAVI reason instead of a doomed PTB.
      const json = (await res.json()) as { error: string; code?: string };
      expect(json.error.length).toBeGreaterThan(0);
      expect(json.code).toBe("NAVI_WITHDRAW_FAILED");
    } else {
      // (b) Build succeeded — chain would reject at submit.
      expect(res.status).toBe(200);
      const { transactionKindB64 } = (await res.json()) as {
        transactionKindB64: string;
      };
      const bytes = fromBase64(transactionKindB64);
      expect(bytes.length).toBeGreaterThan(0);
    }
  });
});
