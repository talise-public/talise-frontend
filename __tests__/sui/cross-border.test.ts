/**
 * Unit test for `web/lib/cross-border.ts` — the cross-border send
 * orchestration brain. We mock the on-main primitives it composes
 * (corridor pricing, FX rate table, KYC tier, transfers state machine)
 * so the assertions cover the orchestration logic without a live DB,
 * FX feed, or Sui stack.
 *
 * Branches asserted (per the feature directive):
 *   1. TIER_BLOCKED   — a tier-0 user is refused a cross-border corridor.
 *   2. LIMIT_EXCEEDED — an amount over the tier's per-tx cap is refused.
 *   3. OVER_CAP       — the registry's per-tx USD cap passes through from
 *                       corridorQuote unchanged.
 *   4. happy quote    — a valid quote creates a `cross_border` transfer in
 *                       `quoted` and returns the locked quote + payout.
 *   5. confirm        — confirm advances the transfer's state off `quoted`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Hoisted mock fns ────────────────────────────────────────────────────
//
// vi.mock factories are hoisted above module-scope consts, so the mock
// functions they reference must be created inside vi.hoisted (which runs
// first). Everything the factories close over comes from this block.
const {
  corridorQuoteMock,
  getUserTierMock,
  createTransferMock,
  getTransferMock,
  advanceTransferMock,
  dbExecuteMock,
} = vi.hoisted(() => ({
  corridorQuoteMock: vi.fn(),
  getUserTierMock: vi.fn(),
  createTransferMock: vi.fn(),
  getTransferMock: vi.fn(),
  advanceTransferMock: vi.fn(),
  dbExecuteMock: vi.fn(async () => ({ rows: [{ total: 0 }] })),
}));

// ─── Hoisted mocks of the composed primitives ───────────────────────────
//
// corridors.ts: getCorridor / isCorridorBookable / corridorAccessForTier
// are pure registry reads; we keep the REAL implementations (importActual)
// so the corridor metadata + tier-access policy are exercised honestly,
// and only stub `corridorQuote` (the priced, network-dependent call).

vi.mock("@/lib/corridors", async () => {
  const actual = await vi.importActual<typeof import("@/lib/corridors")>("@/lib/corridors");
  return {
    ...actual,
    corridorQuote: corridorQuoteMock,
  };
});

// fx-feed.ts: only getRateTable is used (source→USD conversion). A live
// table with USD=1 and NGN per-USD so US-NG (source USD) is trivial and
// NG-source corridors would convert.
vi.mock("@/lib/fx-feed", () => ({
  getRateTable: vi.fn(async () => ({
    ratesPerUsd: {
      USD: 1,
      NGN: 1600,
      KES: 130,
      GHS: 14,
      ZAR: 18,
      JPY: 156,
      SGD: 1.34,
      PHP: 58,
      IDR: 16000,
      VND: 25000,
    },
    asOfMs: Date.now(),
    source: "live" as const,
  })),
}));

// kyc.ts: getUserTier is per-test; TIER_LIMITS keeps the REAL table so the
// inline cap math runs against production limits.
vi.mock("@/lib/kyc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/kyc")>("@/lib/kyc");
  return {
    ...actual,
    getUserTier: getUserTierMock,
  };
});

// transfers.ts: createTransfer / getTransfer / advanceTransfer are fully
// stubbed — we assert the inputs the orchestrator passes them and feed back
// canned records.
vi.mock("@/lib/transfers", () => ({
  createTransfer: createTransferMock,
  getTransfer: getTransferMock,
  advanceTransfer: advanceTransferMock,
}));

// db.ts: only the monthly-usage SUM query is hit. Default to 0 used.
vi.mock("@/lib/db", () => ({
  db: () => ({ execute: dbExecuteMock }),
  ensureSchema: vi.fn(async () => {}),
  // quoteCrossBorder looks the user up to apply the admin tier-3 bypass.
  // null → not an admin → the user keeps their real tier, so the tier-0
  // TIER_BLOCKED / LIMIT_EXCEEDED assertions below stay valid.
  userById: vi.fn(async () => null),
}));

// Import AFTER mocks are registered.
import { quoteCrossBorder, confirmCrossBorder } from "@/lib/cross-border";

// ─── Fixtures ───────────────────────────────────────────────────────────

const USER_ID = 42;

/** A canned live US-NG FX quote (USD→NGN at 1500, post-spread). */
function ngQuote(amountUsd: number) {
  return {
    ok: true as const,
    corridor: {
      id: "US-NG",
      fromCountry: "US" as const,
      fromCcy: "USD" as const,
      toCountry: "NG" as const,
      toCcy: "NGN" as const,
      fiatInRail: "ACH",
      fiatOutRail: "Linq",
      status: "live" as const,
      spreadBps: 150,
      minorUnits: 0,
      licenseNote: "test",
    },
    quote: {
      from: "USD" as const,
      to: "NGN" as const,
      amount: amountUsd,
      rate: 1500,
      midRate: 1600,
      spreadBps: 150,
      toAmount: amountUsd * 1500,
      feedAsOfMs: Date.now(),
      expiresAt: Date.now() + 30_000,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbExecuteMock.mockResolvedValue({ rows: [{ total: 0 }] });
  // Default: createTransfer echoes a quoted record.
  createTransferMock.mockImplementation(async (input: Record<string, unknown>) => ({
    id: "tr_test_1",
    userId: String(input.userId),
    kind: input.kind,
    provider: input.provider,
    state: "quoted",
    sourceCurrency: input.sourceCurrency,
    destCurrency: input.destCurrency,
    usdsuiAmount: input.usdsuiAmount,
    sourceAmount: input.sourceAmount,
    destAmount: input.destAmount,
    fxRate: input.fxRate,
    onchainDigest: null,
    providerReference: null,
    stateReason: null,
    parkedFunds: false,
    metadata: input.metadata ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    debitedAt: null,
    onchainSettledAt: null,
    settledAt: null,
    failedAt: null,
  }));
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe("quoteCrossBorder — KYC gating", () => {
  it("TIER_BLOCKED: a tier-0 user cannot quote a cross-border corridor", async () => {
    getUserTierMock.mockResolvedValue(0);

    const res = await quoteCrossBorder(USER_ID, "US", "NG", 100);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("TIER_BLOCKED");
    // Gated BEFORE pricing — corridorQuote is never reached.
    expect(corridorQuoteMock).not.toHaveBeenCalled();
    expect(createTransferMock).not.toHaveBeenCalled();
  });

  it("LIMIT_EXCEEDED: an amount over the tier per-tx cap is refused before pricing", async () => {
    // Tier 1: perTxUsd = 250. $300 (US source = $300 USD) breaches it.
    getUserTierMock.mockResolvedValue(1);

    // Tier 1 only has DOMESTIC corridor access, so cross-border US-NG would
    // be TIER_BLOCKED first. Use the same-country US-US corridor (live,
    // domestic) so the access gate passes and the CAP gate is what fires.
    const res = await quoteCrossBorder(USER_ID, "US", "US", 300);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("LIMIT_EXCEEDED");
    expect(res.message).toMatch(/per-transaction limit/i);
    expect(corridorQuoteMock).not.toHaveBeenCalled();
    expect(createTransferMock).not.toHaveBeenCalled();
  });

  it("LIMIT_EXCEEDED: rolling monthly cap counts prior usage", async () => {
    // Tier 2: perTxUsd = 5_000, monthlyUsd = 25_000. $4_000 is under the
    // per-tx cap, but $23_000 already used this month pushes it over the
    // monthly cap.
    getUserTierMock.mockResolvedValue(2);
    dbExecuteMock.mockResolvedValue({ rows: [{ total: 23_000 }] });

    const res = await quoteCrossBorder(USER_ID, "US", "NG", 4_000);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("LIMIT_EXCEEDED");
    expect(res.message).toMatch(/monthly limit/i);
    expect(corridorQuoteMock).not.toHaveBeenCalled();
  });
});

describe("quoteCrossBorder — pricing passthrough + happy path", () => {
  it("OVER_CAP: the registry per-tx cap from corridorQuote passes through", async () => {
    getUserTierMock.mockResolvedValue(3); // tier 3 has no inline caps
    corridorQuoteMock.mockResolvedValue({
      ok: false,
      code: "OVER_CAP",
      message: "This corridor caps single transfers at $6,400.",
    });

    // US-JP is a partner corridor with a perTxCapUsd; tier-3 clears the KYC
    // gate so the registry cap is the thing that fires.
    const res = await quoteCrossBorder(USER_ID, "US", "JP", 10_000);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("OVER_CAP");
    expect(corridorQuoteMock).toHaveBeenCalledOnce();
    expect(createTransferMock).not.toHaveBeenCalled();
  });

  it("FX: an unpriceable corridor (feed breaker) passes the FX code through", async () => {
    getUserTierMock.mockResolvedValue(2);
    corridorQuoteMock.mockResolvedValue({
      ok: false,
      code: "FX",
      message: "Live FX feed unavailable; quoting is paused.",
    });

    const res = await quoteCrossBorder(USER_ID, "US", "NG", 100);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("FX");
  });

  it("happy quote: creates a 'quoted' cross_border transfer and returns the locked quote", async () => {
    getUserTierMock.mockResolvedValue(2);
    corridorQuoteMock.mockResolvedValue(ngQuote(100));

    const res = await quoteCrossBorder(USER_ID, "US", "NG", 100);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.message);

    // amountUsd: source USD 100 → $100 (USD source, 1:1).
    expect(res.result.amountUsd).toBe(100);
    expect(res.result.tier).toBe(2);
    expect(res.result.transferId).toBe("tr_test_1");
    expect(res.result.corridor.id).toBe("US-NG");
    expect(res.result.corridor.toCcy).toBe("NGN");
    expect(res.result.quote.rate).toBe(1500);
    expect(res.result.quote.toAmount).toBe(150_000);
    expect(res.result.recipientGets).toEqual({ amount: 150_000, currency: "NGN" });

    // createTransfer was called with the orchestrated shape.
    expect(createTransferMock).toHaveBeenCalledOnce();
    const arg = createTransferMock.mock.calls[0][0];
    expect(arg.kind).toBe("cross_border");
    expect(arg.provider).toBe("linq"); // NG payout → Linq
    expect(arg.sourceCurrency).toBe("USD");
    expect(arg.destCurrency).toBe("NGN");
    expect(arg.usdsuiAmount).toBe(100);
    expect(arg.sourceAmount).toBe(100);
    expect(arg.destAmount).toBe(150_000);
    expect(arg.fxRate).toBe(1500);
    expect(arg.metadata).toMatchObject({
      fromCountry: "US",
      toCountry: "NG",
      corridorId: "US-NG",
    });
  });

  it("BAD_INPUT: a non-positive amount is rejected before any work", async () => {
    const res = await quoteCrossBorder(USER_ID, "US", "NG", 0);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("BAD_INPUT");
    expect(getUserTierMock).not.toHaveBeenCalled();
  });

  it("UNKNOWN_CORRIDOR: an unregistered route is rejected", async () => {
    // NG-NG is not in the registry.
    const res = await quoteCrossBorder(USER_ID, "NG", "NG", 100);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("UNKNOWN_CORRIDOR");
  });
});

describe("confirmCrossBorder — drives the state machine", () => {
  const OWNED_TRANSFER = {
    id: "tr_test_1",
    userId: String(USER_ID),
    kind: "cross_border" as const,
    provider: "linq",
    state: "quoted" as const,
    sourceCurrency: "USD",
    destCurrency: "NGN",
    usdsuiAmount: 100,
    sourceAmount: 100,
    destAmount: 150_000,
    fxRate: 1500,
    onchainDigest: null,
    providerReference: null,
    stateReason: null,
    parkedFunds: false,
    metadata: { fromCountry: "US", toCountry: "NG", corridorId: "US-NG" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    debitedAt: null,
    onchainSettledAt: null,
    settledAt: null,
    failedAt: null,
  };

  it("NG corridor: advances quoted → debited → onchain_settling (Linq fiat-out deferred to commit hook)", async () => {
    getTransferMock.mockResolvedValue(OWNED_TRANSFER);
    // debit → debited, then start_onchain → onchain_settling.
    advanceTransferMock
      .mockResolvedValueOnce({ ok: true, transfer: { ...OWNED_TRANSFER, state: "debited" } })
      .mockResolvedValueOnce({ ok: true, transfer: { ...OWNED_TRANSFER, state: "onchain_settling" } });

    const res = await confirmCrossBorder(USER_ID, "tr_test_1");

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.message);
    // NG leaves the transfer pre-commit; the Linq payout fires from the
    // on-chain-confirm hook after finality.
    expect(res.state).toBe("onchain_settling");
    expect(advanceTransferMock).toHaveBeenCalledTimes(2);
    expect(advanceTransferMock.mock.calls[0][1]).toBe("debit");
    expect(advanceTransferMock.mock.calls[1][1]).toBe("start_onchain");
  });

  it("partner corridor: advances through to fiat_out_pending (documented stub)", async () => {
    const partner = {
      ...OWNED_TRANSFER,
      provider: "partner",
      destCurrency: "JPY",
      metadata: { fromCountry: "US", toCountry: "JP", corridorId: "US-JP" },
    };
    getTransferMock.mockResolvedValue(partner);
    advanceTransferMock
      .mockResolvedValueOnce({ ok: true, transfer: { ...partner, state: "debited" } })
      .mockResolvedValueOnce({ ok: true, transfer: { ...partner, state: "onchain_settling" } })
      .mockResolvedValueOnce({ ok: true, transfer: { ...partner, state: "onchain_settled" } })
      .mockResolvedValueOnce({ ok: true, transfer: { ...partner, state: "fiat_out_pending" } });

    const res = await confirmCrossBorder(USER_ID, "tr_test_1");

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.message);
    expect(res.state).toBe("fiat_out_pending");
    expect(advanceTransferMock).toHaveBeenCalledTimes(4);
    expect(advanceTransferMock.mock.calls.map((c) => c[1])).toEqual([
      "debit",
      "start_onchain",
      "confirm_onchain",
      "start_fiat_out",
    ]);
  });

  it("FORBIDDEN: a transfer owned by another user cannot be confirmed", async () => {
    getTransferMock.mockResolvedValue({ ...OWNED_TRANSFER, userId: "999" });

    const res = await confirmCrossBorder(USER_ID, "tr_test_1");

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("FORBIDDEN");
    expect(advanceTransferMock).not.toHaveBeenCalled();
  });

  it("NOT_FOUND: a missing transfer id is rejected", async () => {
    getTransferMock.mockResolvedValue(null);

    const res = await confirmCrossBorder(USER_ID, "nope");

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("NOT_FOUND");
  });

  it("CONFLICT: an already-advanced transfer fails the transition guard", async () => {
    getTransferMock.mockResolvedValue(OWNED_TRANSFER);
    advanceTransferMock.mockResolvedValueOnce({
      ok: false,
      code: "illegal_transition",
      message: "no 'debit' transition from 'settled'",
    });

    const res = await confirmCrossBorder(USER_ID, "tr_test_1");

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("CONFLICT");
  });
});
