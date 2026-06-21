/**
 * Integration tests for `/api/earn/withdraw/prepare` — speed + outer cap.
 *
 * Context (2026-05-29): users were hitting iOS's default URLSession 60s
 * timeout on the Earnings → Withdraw flow. Root cause: an unbounded
 * NAVI position read inside `appendNaviWithdraw`. Mirror of the
 * activity-feed fix — wrap each leg with `withTimeout` and cap the
 * outer pipeline at 10s so we return a clean 504 instead of letting
 * iOS time out.
 *
 * Tests:
 *   1. Happy path returns in <8s (wall-clock).
 *   2. A stalled NAVI read trips the outer 10s cap and the route
 *      returns 504 with the canonical "try again" message.
 *
 * Auth is mocked at the boundary (same pattern as withdraw.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Transaction } from "@mysten/sui/transactions";

vi.mock("@/lib/mobile-sessions", () => ({
  readEntryIdFromRequest: vi.fn(async () => 1),
  isMobileRequest: vi.fn(() => true),
}));

vi.mock("@/lib/db", () => ({
  userById: vi.fn(async () => ({
    id: 1,
    google_sub: "test-sub",
    email: "withdraw-speed-test@talise.local",
    name: "Withdraw Speed Test",
    picture: null,
    sui_address:
      "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29",
    salt: "1",
    country: "US",
    created_at: 0,
    last_seen_at: 0,
  })),
}));

// Toggle controls how `appendNaviWithdraw` behaves per-test. The
// default is fast (resolve in ~0ms); `stall=true` returns a promise
// that never resolves — exactly the failure mode we're hardening
// against (the activity-feed bug all over again).
let stall = false;

vi.mock("@/lib/navi-supply", () => ({
  appendNaviWithdraw: vi.fn(async (tx: Transaction) => {
    if (stall) {
      // Mirror a wedged RPC — return a promise that NEVER resolves so
      // the outer 10s cap is the only thing that breaks the request.
      await new Promise(() => {});
      return;
    }
    tx.moveCall({
      target: "0x2::clock::timestamp_ms",
      arguments: [tx.object("0x6")],
    });
  }),
}));

vi.mock("@/lib/deepbook-margin", () => ({
  fetchSupplierCapId: vi.fn(async () => null),
  buildWithdrawUsdsuiMargin: vi.fn(() => ({ build: (_: Transaction) => {} })),
}));

vi.mock("@/lib/intents/wrap-payment-kit", () => ({
  appendPaymentKitReceipt: vi.fn(() => ({
    nonce: "tlse1earn00000000aaaaaaaa",
  })),
}));

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

describe("POST /api/earn/withdraw/prepare — speed + outer cap", () => {
  beforeEach(() => {
    stall = false;
  });

  it("happy path returns in <8s on a healthy NAVI adapter", async () => {
    const t0 = Date.now();
    const res = await postWithdraw({ venue: "navi", amount: 5 });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    // Wall-clock budget. Healthy mocked adapter resolves immediately,
    // so a passing build should land well under 100ms; the 8s bound
    // gives generous CI headroom while still catching a regression
    // where someone removes the timeouts and a real RPC slips in.
    expect(elapsed).toBeLessThan(8_000);
  });

  it(
    "hard-caps at 10s and returns 504 when NAVI position read stalls",
    async () => {
      stall = true;
      const t0 = Date.now();
      const res = await postWithdraw({ venue: "navi", amount: 5 });
      const elapsed = Date.now() - t0;

      // The inner `withTimeout` on the NAVI leg fires at 5s and the
      // route returns 504 — well before the outer 10s cap. Either is
      // acceptable; we assert the response shape, not which timer
      // tripped.
      expect(res.status).toBe(504);
      // Must be under the outer cap + a small grace window.
      expect(elapsed).toBeLessThan(11_000);

      const json = (await res.json()) as { error: string };
      // Either timer is acceptable: the inner NAVI leg ("NAVI is
      // responding slowly") at 5s, or the outer cap ("taking longer
      // than usual") at 10s.
      expect(json.error).toMatch(/responding slowly|longer than usual/i);
    },
    15_000 // vitest per-test timeout — must exceed the 10s outer cap
  );
});
