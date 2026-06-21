/**
 * Integration test for `POST /api/earn/supply/prepare` — the NAVI supply
 * leg of the sponsored (Onara gas) yield flow.
 *
 * What we exercise:
 *   1. A `{ venue: "navi", amount: 1.00 }` body is accepted, the route
 *      composes the supply PTB (NAVI leg via `appendNaviSupply` +
 *      universal payment-kit receipt) and returns a serialized
 *      transaction-kind blob plus the venue/amount/receiptNonce
 *      metadata the sponsor leg downstream expects.
 *   2. The returned `transactionKindB64` decodes to a non-empty
 *      `Uint8Array`.
 *   3. Schema validation: an unsupported `venue` returns HTTP 400.
 *   4. Schema validation: a non-positive `amount` (zero or negative)
 *      returns HTTP 400.
 *
 * What we DO NOT do: submit the transaction, sign it, or call the
 * sponsor route. `onlyTransactionKind: true` keeps the build read-only
 * — no gas object resolution, no signing, no on-chain side effects.
 *
 * Auth: `readEntryIdFromRequest` + `userById` are mocked to return a
 * fixed stub user (same shape/options as the 4.1 send.prepare test).
 *
 * NAVI adapter: `appendNaviSupply` is mocked to add a benign
 * `0x2::coin::zero<USDsui>` MoveCall onto the transaction. The real
 * adapter requires the sender to actually hold the USDsui being
 * supplied (it calls `coinWithBalance({ useGasCoin: false })`, which
 * resolves a real on-chain coin object). We don't want this test
 * coupled to a specific funded mainnet address — the NAVI adapter has
 * its own coverage upstream in `@t2000/sdk`. The route's contract
 * (dispatch by venue, append receipt, serialize, return shape) is
 * exactly what we want to assert here.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";

// ─── Auth + DB stubs ─────────────────────────────────────────────────────
// Mock these BEFORE importing the route so the route picks up the mocks.
// Same pattern as the 4.1 send.prepare test: bypass session lookup,
// return a fixed user row with a real mainnet address.
const STUB_USER_ID = 1;
const STUB_SUI_ADDRESS =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29";

vi.mock("@/lib/mobile-sessions", () => ({
  readEntryIdFromRequest: vi.fn(async () => STUB_USER_ID),
  isMobileRequest: vi.fn(() => true),
}));

// Stub `appendNaviSupply` with a benign MoveCall so the route can build
// a serialized PTB without a real USDsui-funded sender. Asserts the
// route reached the NAVI dispatch arm.
const appendNaviSupplyCalls: Array<{ sender: string; amount: number }> = [];
vi.mock("@/lib/navi-supply", () => ({
  appendNaviSupply: vi.fn(
    async (tx: { moveCall: (args: unknown) => void }, sender: string, amount: number) => {
      appendNaviSupplyCalls.push({ sender, amount });
      // `0x2::coin::zero<T>()` is a real, well-formed MoveCall that
      // takes no inputs and returns a Coin<T> handle. Using it here
      // means the PTB serializes cleanly under `onlyTransactionKind`
      // without touching any of the sender's coin objects.
      tx.moveCall({
        target: "0x2::coin::zero",
        typeArguments: [
          "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI",
        ],
        arguments: [],
      });
    }
  ),
}));

// `appendPaymentKitReceipt` internally appends a `processRegistryPayment`
// MoveCall that resolves `coinWithBalance` against the sender at build
// time — same external-balance dependency we're avoiding for NAVI. Stub
// with a no-op MoveCall and surface the deterministic nonce the route
// is expected to echo back.
const STUB_NONCE = "test-receipt-nonce";
vi.mock("@/lib/intents/wrap-payment-kit", () => ({
  appendPaymentKitReceipt: vi.fn(
    (tx: { moveCall: (args: unknown) => void }, _opts: unknown) => {
      tx.moveCall({
        target: "0x2::tx_context::sender",
        typeArguments: [],
        arguments: [],
      });
      return { nonce: STUB_NONCE };
    }
  ),
}));

vi.mock("@/lib/db", () => ({
  userById: vi.fn(async (id: number) => {
    if (id !== STUB_USER_ID) return null;
    return {
      id: STUB_USER_ID,
      google_sub: "stub-sub",
      email: "claudedummies@gmail.com",
      name: "Stub User",
      picture: null,
      sui_address: STUB_SUI_ADDRESS,
      salt: "0",
      country: null,
      created_at: 0,
      last_seen_at: 0,
      notified_at: null,
      account_type: "personal" as const,
      business_name: null,
      business_handle: null,
      business_industry: null,
      talise_username: "stub",
    };
  }),
}));

// Defer route import until after the mocks are registered. Vitest hoists
// `vi.mock` calls above imports, but using a dynamic import inside
// `beforeAll` makes the ordering explicit and avoids any race with the
// route's transitive `import "server-only"` boundary.
let POST: (req: Request) => Promise<Response>;
beforeAll(async () => {
  const mod = await import("../../app/api/earn/supply/prepare/route");
  POST = mod.POST as typeof POST;
});

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/earn/supply/prepare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function decodeBase64(b64: string): Uint8Array {
  // Buffer is available in Vitest's Node env; this matches what the
  // server-side @mysten/sui `fromBase64` does internally.
  return new Uint8Array(Buffer.from(b64, "base64"));
}

describe("POST /api/earn/supply/prepare (NAVI sponsored path)", () => {
  it("prepares a NAVI supply PTB for { venue: 'navi', amount: 1.00 }", async () => {
    appendNaviSupplyCalls.length = 0;
    const res = await POST(makeRequest({ venue: "navi", amount: 1.0 }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      transactionKindB64: string;
      venue: string;
      amount: number;
      receiptNonce: string;
    };
    expect(typeof json.transactionKindB64).toBe("string");
    expect(json.transactionKindB64.length).toBeGreaterThan(0);
    expect(json.venue).toBe("navi");
    expect(json.amount).toBe(1.0);
    expect(json.receiptNonce).toBe(STUB_NONCE);
    // Route must have hit the NAVI dispatch arm with the right inputs.
    expect(appendNaviSupplyCalls).toHaveLength(1);
    expect(appendNaviSupplyCalls[0]).toEqual({
      sender: STUB_SUI_ADDRESS,
      amount: 1.0,
    });
  }, 30_000);

  it("returns transactionKindB64 that decodes to a non-empty Uint8Array", async () => {
    const res = await POST(makeRequest({ venue: "navi", amount: 1.0 }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { transactionKindB64: string };

    const bytes = decodeBase64(json.transactionKindB64);
    expect(bytes).toBeInstanceOf(Uint8Array);
    // BCS-serialized PTB-kind with the NAVI supply MoveCalls + the
    // payment-kit receipt self-ping is always well above a few hundred
    // bytes. We assert > 32 as a very conservative non-empty floor.
    expect(bytes.byteLength).toBeGreaterThan(32);
  }, 30_000);

  it("rejects an unsupported venue with HTTP 400", async () => {
    const res = await POST(makeRequest({ venue: "bogus-venue", amount: 1.0 }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(typeof json.error).toBe("string");
    expect(json.error.toLowerCase()).toContain("venue");
  });

  it("rejects a zero amount with HTTP 400", async () => {
    const res = await POST(makeRequest({ venue: "navi", amount: 0 }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error.toLowerCase()).toContain("amount");
  });

  it("rejects a negative amount with HTTP 400", async () => {
    const res = await POST(makeRequest({ venue: "navi", amount: -5 }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error.toLowerCase()).toContain("amount");
  });
});
