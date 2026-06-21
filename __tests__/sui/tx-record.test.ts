/**
 * Integration test for `/api/tx/record` after sub-plan 1.4 — the route now
 * reads its on-chain truth from the canonical `getNormalizedTransaction()`
 * helper in `lib/sui-shapes.ts` instead of touching the raw JSON-RPC client.
 *
 * What this file exercises (against real Sui mainnet):
 *   1. The route's happy path — a well-formed body with a known mainnet
 *      digest and no `invoiceSlug` records the tx and returns 200 {ok:true}.
 *      No chain verification fires on this branch, but it confirms the
 *      route still imports + runs after the migration.
 *   2. Malformed digest input is rejected with 400 BEFORE any chain hit.
 *   3. A digest the chain-side verifier finds invalid (merchant did NOT
 *      receive the expected USDsui amount on that tx) — exercised through
 *      `invoiceSlug` so `verifyAndCloseInvoice` runs against mainnet.
 *      The route returns 400 with `error: "invoice verification failed: ..."`.
 *      This is documented in-line below as the verifier's failure status.
 *   4. The normalizer's `events[].txDigest` injection (the gap that
 *      patterns.md flags on gRPC) is still present on the same call the
 *      route makes — asserted by invoking `getNormalizedTransaction()`
 *      directly with the same digest.
 *
 * Auth bypass strategy: `/api/tx/record` is listed in
 * `APP_ATTEST_REQUIRED_PREFIXES`, but `requireAppAttestStructural` is a no-op
 * when `isMobileRequest(req)` is false — and that helper only returns true
 * for requests with an `Authorization: Bearer …` header. The Requests we
 * build below intentionally omit that header, so the App Attest gate skips
 * itself. Session + DB are stubbed via `vi.mock` so the route never reaches
 * Postgres.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getNormalizedTransaction,
  type NormalizedTransaction,
} from "../../lib/sui-shapes";

// Reused from `normalize-tx.test.ts` (sub-plan 1.3). That file does not
// re-export the constant — keep them in sync if either digest gets pruned
// from mainnet. This is a NAVI price_oracle update PTB with status:success,
// multiple events, and a non-empty balanceChanges array.
const KNOWN_MAINNET_DIGEST = "3stu52xPwLZDTtA5kfTk9HaFYn8wnys2YGeQSTeF2xqZ";

// ─── Module mocks ────────────────────────────────────────────────────────────
// Session: pretend the request carries a valid cookie for user 1.
vi.mock("@/lib/session", () => ({
  readSessionEntryId: vi.fn(async () => 1),
}));

// DB: stub the surface `/api/tx/record` reaches. Spy bodies so we can also
// assert recordTx was called with the right shape on the happy path.
const recordTxSpy = vi.fn(async (_arg: unknown) => {});
const markInvoicePaidSpy = vi.fn(
  async (_slug: unknown, _digest: unknown, _payer: unknown) => {}
);
const setInvoiceReceiptObjectIdSpy = vi.fn(
  async (_slug: unknown, _receiptId: unknown) => {}
);

// Mutated per-test to drive the verifier branches. Default is a benign
// "open" invoice owned by a merchant who definitely doesn't appear in the
// NAVI oracle tx's balanceChanges — so the merchant-received check fails.
let mockInvoice: {
  slug: string;
  business_user_id: number;
  amount_usdc: number | string;
  status: string;
} | null = null;
let mockMerchant: { id: number; sui_address: string } | null = null;

vi.mock("@/lib/db", () => ({
  recordTx: (arg: unknown) => recordTxSpy(arg),
  markInvoicePaid: (slug: unknown, digest: unknown, payer: unknown) =>
    markInvoicePaidSpy(slug, digest, payer),
  setInvoiceReceiptObjectId: (slug: unknown, receiptId: unknown) =>
    setInvoiceReceiptObjectIdSpy(slug, receiptId),
  invoiceBySlug: vi.fn(async (slug: string) =>
    mockInvoice && mockInvoice.slug === slug ? mockInvoice : null
  ),
  userById: vi.fn(async (id: number) => {
    // The route calls userById twice in the invoice branch (caller +
    // merchant). 1 = the authenticated caller, 2 = the merchant.
    if (id === 1) {
      return {
        id: 1,
        sui_address: "0x" + "11".repeat(32),
        // Other User fields are unused by the route — leave them undefined.
      };
    }
    if (mockMerchant && id === mockMerchant.id) return mockMerchant;
    return null;
  }),
}));

// Import the route AFTER the mocks are in place. Static `import` would
// bind the real modules before `vi.mock` registers; the awaited dynamic
// import inside `beforeAll` is the standard Vitest pattern for this.
async function loadRoute() {
  return await import("../../app/api/tx/record/route");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function postBody(body: unknown): Request {
  return new Request("https://test.local/api/tx/record", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { _raw: text };
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("/api/tx/record — sub-plan 1.4 verifier (gRPC NormalizedTransaction)", () => {
  beforeEach(() => {
    recordTxSpy.mockClear();
    markInvoicePaidSpy.mockClear();
    setInvoiceReceiptObjectIdSpy.mockClear();
    mockInvoice = null;
    mockMerchant = null;
  });

  it("accepts a known mainnet digest (no invoice) → 200 ok", async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      postBody({
        digest: KNOWN_MAINNET_DIGEST,
        kind: "send",
        amount: "1.00",
        asset: "USDsui",
      })
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    // The route persists a hint row — confirm shape (digest + userId).
    expect(recordTxSpy).toHaveBeenCalledTimes(1);
    const arg = recordTxSpy.mock.calls[0]?.[0] as unknown as {
      digest: string;
      userId: number;
    };
    expect(arg.digest).toBe(KNOWN_MAINNET_DIGEST);
    expect(arg.userId).toBe(1);
  }, 30_000);

  it("rejects a malformed digest with 400 before touching the chain", async () => {
    const { POST } = await loadRoute();
    const res = await POST(postBody({ digest: "not-a-real-digest!!" }));
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(typeof body.error).toBe("string");
    expect(String(body.error)).toMatch(/digest/i);
    // No DB write should have happened for a 400-on-input path.
    expect(recordTxSpy).not.toHaveBeenCalled();
  }, 10_000);

  it("rejects when the on-chain verifier finds the merchant under-paid → 400", async () => {
    // Drive the invoice branch. The merchant address is intentionally one
    // that does NOT appear in KNOWN_MAINNET_DIGEST's balanceChanges, so
    // `verifyAndCloseInvoice` walks the normalized tx, finds 0 USDsui paid
    // to the merchant, and bails with status 400.
    //
    // Documented error code: the route returns **400** (NOT 422) with body
    // `{ error: "invoice verification failed: recipient received 0 micro
    // USDsui, expected >= 1000000" }`. The 422 in the task spec was the
    // hypothetical "or whatever the verifier returns" fallback; 400 is the
    // actual contract.
    mockInvoice = {
      slug: "test-invoice",
      business_user_id: 2,
      amount_usdc: 1, // 1 USDsui = 1_000_000 micro-units
      status: "open",
    };
    mockMerchant = {
      id: 2,
      sui_address: "0x" + "ab".repeat(32),
    };
    const { POST } = await loadRoute();
    const res = await POST(
      postBody({
        digest: KNOWN_MAINNET_DIGEST,
        kind: "pay-invoice",
        invoiceSlug: "test-invoice",
      })
    );
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(String(body.error)).toMatch(/invoice verification failed/i);
    // The verifier must have walked the actual chain response — its
    // failure reason includes the "recipient received N micro USDsui"
    // string the route builds from `balanceChanges`.
    expect(String(body.error)).toMatch(/recipient received/i);
    // Invoice must NOT have been marked paid.
    expect(markInvoicePaidSpy).not.toHaveBeenCalled();
  }, 30_000);

  it("preserves the normalizer's events[].txDigest injection on the same call the route makes", async () => {
    // The route calls `getNormalizedTransaction(digest)` inside
    // `verifyAndCloseInvoice`. We exercise the same helper directly and
    // assert the event-row `txDigest` is the OUTER digest (gRPC doesn't
    // emit it natively — patterns.md flags this as a shape gap covered
    // by `sui-shapes.normalizeFromGrpc`).
    const tx: NormalizedTransaction = await getNormalizedTransaction(
      KNOWN_MAINNET_DIGEST
    );
    expect(tx.digest).toBe(KNOWN_MAINNET_DIGEST);
    expect(tx.status).toBe("success");
    expect(Array.isArray(tx.events)).toBe(true);
    expect(tx.events.length).toBeGreaterThan(0);
    for (const ev of tx.events) {
      expect(ev.txDigest).toBe(KNOWN_MAINNET_DIGEST);
    }
    // balanceChanges is also what `/api/tx/record` walks; sanity-check
    // shape so a regression in either field gets caught here too.
    expect(Array.isArray(tx.balanceChanges)).toBe(true);
    for (const bc of tx.balanceChanges) {
      expect(typeof bc.coinType).toBe("string");
      expect(typeof bc.amount).toBe("bigint");
    }
  }, 30_000);
});
