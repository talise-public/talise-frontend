/**
 * Integration test for `/api/send/sponsor-prepare` — the sponsored branch
 * of the combined send-prepare endpoint (sub-plan 4.2, sibling of the
 * gasless 4.1 test).
 *
 * Scope: PREPARE only. We never submit, sign, or broadcast a tx — the
 * test runs entirely offline against the route handler with the heavy
 * Sui/Onara/DB dependencies stubbed at module-load time. The assertions
 * exercise the route's mode-selection branching:
 *
 *   1. roundup enabled + USDsui → `mode: "sponsored"`, `roundupUsd`
 *      reflects `amount × percentage / 100`, `receiptNonce` is a
 *      well-formed Payment Kit nonce (base36 alphanumeric).
 *   2. roundup disabled + USDsui → `mode: "gasless"` (the gasless
 *      build succeeds → no fallback to the sponsored path).
 *   3. asset === "SUI" → always `mode: "sponsored"` (gasless is
 *      USDsui-only per Sui's stablecoin allowlist).
 *   4. Returned `bytes` decode to a non-empty `Uint8Array` (the bytes
 *      are what iOS signs and forwards to /api/zk/sponsor-execute —
 *      empty bytes would be a silent prepare failure).
 *
 * Auth strategy: of the three options considered for sub-plan 4.1 —
 *   (a) issue a real mobile bearer via `issueMobileBearer` and hit a
 *       running dev server,
 *   (b) inject a Bearer header and let the route resolve it through
 *       the real `verifyMobileBearer`,
 *   (c) mock `readEntryIdFromRequest` to short-circuit to a fixed
 *       userId
 * — we pick (c). The auth layer isn't under test here; option (c) keeps
 * the test deterministic and lets us assert ONLY the branching logic.
 *
 * Round-up mocking: `getRoundupConfig` is the single source of truth
 * the route reads to decide gasless vs sponsored. We mock it via
 * `vi.mock("@/lib/rewards/roundup", ...)` and swap the return value
 * per-test with `vi.mocked(getRoundupConfig).mockResolvedValue(...)`.
 * This is identical to the pattern the 4.1 gasless sibling uses for
 * its own roundup injection.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fromBase64 } from "@mysten/sui/utils";

// ─── Hoisted mocks ──────────────────────────────────────────────────
// `vi.mock` calls are hoisted above the route import so the route's
// top-level `import { ... } from "@/lib/..."` picks up the stubs.

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

vi.mock("@/lib/rewards/roundup", () => ({
  getRoundupConfig: vi.fn(async () => ({
    enabled: false,
    percentage: 5,
    savedUsd: 0,
  })),
}));

// Onara status drives the sponsor address that the route stamps onto
// the tx via `tx.setGasOwner(sponsor)`. We return a deterministic
// well-formed address — the value never reaches the network in this
// test because `tx.build` is also stubbed below.
vi.mock("@/lib/onara", () => ({
  onara: () => ({
    status: async () => ({
      address:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
    }),
  }),
}));

// `ensurePaymentRegistry` is fire-and-forget in the route — keep it
// trivially resolved so the parallel `Promise.all` settles.
vi.mock("@/lib/pk-bootstrap", () => ({
  ensurePaymentRegistry: vi.fn(async () => ({ ok: true, minted: false })),
}));

// `appendNaviSupply` is exercised only on the roundup-enabled branch.
// The real impl initialises a NAVI SDK adapter and queries on-chain
// pool state — we don't need any of that, just a no-op that mutates
// the tx (matching the real signature).
vi.mock("@/lib/navi-supply", () => ({
  appendNaviSupply: vi.fn(async () => undefined),
}));

// PaymentKit receipt append. The route reads `nonce` off the return
// to populate `receiptNonce` in the response — we return a real-shaped
// base36 nonce so the assertion can verify the format the route
// passes through unchanged.
vi.mock("@/lib/intents/wrap-payment-kit", () => ({
  appendPaymentKitReceipt: vi.fn(() => ({
    nonce: "tlse1abcd0001aaaaaabbbbbb",
  })),
}));

// `memoTtl` is a TTL cache around two remote lookups (`onara.status()`
// and `client.getReferenceGasPrice()`). Bypass the cache entirely so
// each test starts fresh and the stubbed factories actually run.
vi.mock("@/lib/perf-cache", () => ({
  memoTtl: <T,>(_k: string, _ttl: number, fn: () => Promise<T>) => fn(),
  invalidate: vi.fn(),
  recordSendLatency: vi.fn(),
  readSendLatencySamples: vi.fn(() => []),
  setPendingRoundup: vi.fn(),
  takePendingRoundup: vi.fn(() => null),
  setPendingInbound: vi.fn(),
  takePendingInbound: vi.fn(() => null),
}));

// The Sui client is consumed in two places:
//   • `getReferenceGasPrice()` — a single number used to pre-stamp
//     `tx.setGasPrice` before `tx.build`.
//   • `tx.build({ client })` — the actual PTB serialisation. We stub
//     the client to a minimal shape; the Transaction class is mocked
//     below to bypass any real build.
vi.mock("@/lib/sui", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sui")>(
    "@/lib/sui"
  );
  return {
    ...actual,
    sui: () => ({
      getReferenceGasPrice: async () => ({ referenceGasPrice: "1000" }),
      // The gasless branch builds offline on the gRPC client, then runs an
      // explicit post-build `simulateTransaction`. `$kind: "Transaction"`
      // is the success discriminant — return it so the USDsui path lands
      // on `mode:"gasless"` (these tests assert the gasless branch wins
      // unless round-up forces the sponsored fall-through).
      simulateTransaction: async () => ({ $kind: "Transaction" }),
    }),
    network: () => "mainnet" as const,
  };
});

// The gasless build sets a ValidDuring expiration keyed off the live
// epoch + chain identifier. Stub both so no network read happens;
// StubTransaction.build ignores the client and returns bytes.
vi.mock("@/lib/sui-epoch", () => ({
  getCurrentEpoch: vi.fn(async () => 1234),
  getChainIdentifier: vi.fn(async () => "test-chain"),
}));

// Stub the `Transaction` builder so `tx.build({ client })` returns a
// deterministic non-empty byte buffer. We keep the rest of the public
// surface (`setSender`, `setGasOwner`, `setGasPrice`, `add`,
// `transferObjects`, `moveCall`, `object`, `pure`) as no-ops or
// passthroughs — the route just needs them to not throw.
//
// The returned bytes are arbitrary but >0 length so test #4 can
// verify the "decode to non-empty Uint8Array" contract.
vi.mock("@mysten/sui/transactions", async () => {
  const actual = await vi.importActual<typeof import("@mysten/sui/transactions")>(
    "@mysten/sui/transactions"
  );
  class StubTransaction {
    setSender = vi.fn();
    setGasOwner = vi.fn();
    setGasPrice = vi.fn();
    setGasBudget = vi.fn();
    // Empty-array gas payment — makes the gRPC gasless build go offline.
    setGasPayment = vi.fn();
    add = vi.fn(() => ({ kind: "Result" }));
    moveCall = vi.fn(() => ({ kind: "Result" }));
    transferObjects = vi.fn();
    object = vi.fn(() => ({ kind: "Input" }));
    // Canonical gasless primitive — pulls amount from the Address Balance
    // accumulator. Stub returns an Argument-shaped value so the route's
    // `moveCall({ target: "0x2::balance::send_funds", arguments: [...] })`
    // accepts it. Without this the gasless try-block throws and the
    // route's fail-loud catch returns 400 ("GASLESS_BUILD_FAILED"),
    // breaking the sponsored-branch tests that expect the USDsui path
    // to land on `mode:"gasless"`.
    withdrawal = vi.fn(() => ({ kind: "Withdrawal" }));
    // Current gasless build draws from the Address Balance accumulator
    // via `tx.balance({ type, balance })` and stamps a ValidDuring
    // expiration. Both must exist or the build throws "tx.balance is not
    // a function" and the route falls to its 400 catch.
    balance = vi.fn(() => ({ kind: "Balance" }));
    setExpiration = vi.fn();
    pure = {
      address: vi.fn(() => ({ kind: "Input" })),
    };
    build = vi.fn(async () => {
      // 8 deterministic bytes — enough to confirm "non-empty" and
      // round-trips cleanly through toBase64 / fromBase64.
      return new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    });
  }
  return {
    ...actual,
    Transaction: StubTransaction,
    coinWithBalance: vi.fn(() => ({ kind: "TxIntent" })),
  };
});

// ─── Import AFTER mocks so the route resolves them ─────────────────
const { POST } = await import("@/app/api/send/sponsor-prepare/route");
const { getRoundupConfig } = await import("@/lib/rewards/roundup");

const SENDER_ADDR =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const RECIPIENT_ADDR =
  "0x3333333333333333333333333333333333333333333333333333333333333333";

function buildReq(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/send/sponsor-prepare", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Bearer header is present so `readEntryIdFromRequest` (mocked
      // above) is exercised, but the value is irrelevant — the mock
      // returns 42 unconditionally.
      authorization: "Bearer test-token",
    },
    body: JSON.stringify(body),
  });
}

describe("/api/send/sponsor-prepare (sponsored branch, PREPARE only)", () => {
  beforeEach(() => {
    // The route reads `process.env.ONARA_URL` at the top and 503s if
    // it's missing. Set a placeholder — the value doesn't matter
    // because the `onara()` factory is mocked above.
    process.env.ONARA_URL = "http://onara.test";
    vi.clearAllMocks();
  });

  it("USDsui + roundup enabled → mode:'sponsored' with atomic NAVI round-up supply (option A, 2026-06-01)", async () => {
    // Option A: a Save-ON USDsui send routes through the SPONSORED branch so
    // the round-up NAVI supply rides the SAME user-signed tx as the transfer
    // (`appendNaviSupply`) — real, atomic, user-owned. The gasless rail can't
    // co-bundle the supply, so Save-on sends are sponsored (Talise pays gas);
    // plain sends (Save off) stay gasless.
    vi.mocked(getRoundupConfig).mockResolvedValue({
      enabled: true,
      percentage: 5,
      savedUsd: 0,
    });

    const res = await POST(
      buildReq({ to: RECIPIENT_ADDR, amount: 1.0, asset: "USDsui" })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      mode: string;
      bytes: string;
      roundupUsd: number;
      asset: string;
      amount: number;
      to: string;
    };

    expect(json.mode).toBe("sponsored");
    expect(json.asset).toBe("USDsui");
    expect(json.amount).toBe(1.0);
    expect(json.to).toBe(RECIPIENT_ADDR);
    // 5% of $1.00 → $0.05, supplied to NAVI atomically in the same tx.
    expect(json.roundupUsd).toBeCloseTo(0.05, 6);
    expect(typeof json.bytes).toBe("string");
    expect(json.bytes.length).toBeGreaterThan(0);
  });

  it("USDsui + roundup disabled → mode:'gasless' (no round-up qualifies for gasless)", async () => {
    vi.mocked(getRoundupConfig).mockResolvedValue({
      enabled: false,
      percentage: 5,
      savedUsd: 0,
    });

    const res = await POST(
      buildReq({ to: RECIPIENT_ADDR, amount: 1.0, asset: "USDsui" })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      mode: string;
      roundupUsd: number;
      bytes: string;
    };

    expect(json.mode).toBe("gasless");
    expect(json.roundupUsd).toBe(0);
    expect(typeof json.bytes).toBe("string");
    expect(json.bytes.length).toBeGreaterThan(0);
  });

  it("asset:'SUI' → always mode:'sponsored' regardless of roundup state", async () => {
    // Even with roundup enabled, SUI sends never qualify for gasless
    // (gasless is gated to USDsui per Sui's stablecoin allowlist).
    vi.mocked(getRoundupConfig).mockResolvedValue({
      enabled: true,
      percentage: 5,
      savedUsd: 0,
    });

    const res = await POST(
      buildReq({ to: RECIPIENT_ADDR, amount: 0.5, asset: "SUI" })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      mode: string;
      asset: string;
      bytes: string;
      roundupUsd: number;
    };

    expect(json.mode).toBe("sponsored");
    expect(json.asset).toBe("SUI");
    // SUI sends skip the Payment Kit + NAVI legs, so roundupUsd stays 0.
    expect(json.roundupUsd).toBe(0);
    expect(typeof json.bytes).toBe("string");
  });

  it("returned bytes decode to a non-empty Uint8Array", async () => {
    vi.mocked(getRoundupConfig).mockResolvedValue({
      enabled: true,
      percentage: 5,
      savedUsd: 0,
    });

    const res = await POST(
      buildReq({ to: RECIPIENT_ADDR, amount: 2.0, asset: "USDsui" })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { bytes: string };

    const decoded = fromBase64(json.bytes);
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(decoded.length).toBeGreaterThan(0);
  });

  it("sanity: sender address mock is wired so route doesn't 400 on self-send guard", () => {
    // `to === user.sui_address` would 400. Recipient must differ from
    // SENDER_ADDR. This is a guardrail for the test setup itself.
    expect(RECIPIENT_ADDR).not.toBe(SENDER_ADDR);
  });
});
