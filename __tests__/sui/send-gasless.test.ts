/**
 * Integration test for `/api/send/sponsor-prepare` — the **gasless**
 * branch of the combined send-prepare endpoint (sub-plan 4.1, sibling
 * of the sponsored 4.2 test in `send-sponsored.test.ts`).
 *
 * Scope: PREPARE only. We never submit, sign, or broadcast a tx — the
 * submit endpoint (`/api/send/gasless-submit`) requires a valid
 * zkLogin signature which can't be faked deterministically in a unit
 * test. The assertions exercise the route's mode-selection branching
 * for the gasless eligibility window:
 *
 *   1. Plain USDsui send (no round-up) → `mode: "gasless"`,
 *      `roundupUsd: 0`, base64 bytes.
 *   2. Small USDsui amount (0.001) → still gasless. The route has
 *      NO minimum threshold above `amount > 0` + `onchain > 0`
 *      (verified by reading the validation block in the route).
 *      0.001 USDsui = 1000 micro-units > 0, so the request succeeds.
 *      Documented here so future floor changes are caught.
 *   3. Returned `bytes` decode to a non-empty `Uint8Array` (the bytes
 *      are what iOS signs and forwards to /api/send/gasless-submit —
 *      empty bytes would be a silent prepare failure).
 *
 * Auth strategy: per the sub-plan 4.1 brief we picked option (c) —
 * mock `readEntryIdFromRequest` to short-circuit to a fixed userId.
 * This matches the pattern the sponsored sibling uses and keeps the
 * test deterministic without standing up a dev server or a real
 * mobile bearer. The auth layer isn't under test here; the route's
 * mode-selection branching is.
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
    roundup_percentage: 0,
  })),
}));

// Gasless eligibility hinges on `getRoundupConfig` returning
// `enabled: false` (or zero percentage) — anything else flips the
// route to sponsored mode. Default the mock to disabled; tests can
// override with `vi.mocked(getRoundupConfig).mockResolvedValue(...)`.
vi.mock("@/lib/rewards/roundup", () => ({
  getRoundupConfig: vi.fn(async () => ({
    enabled: false,
    percentage: 0,
    savedUsd: 0,
  })),
}));

// The gasless branch never touches Onara, but the route loads the
// module at the top so we stub it to a no-op. If the route's gasless
// build ever throws + falls through to sponsored, this stub keeps the
// fallback path from hitting a real Onara host.
vi.mock("@/lib/onara", () => ({
  onara: () => ({
    status: async () => ({
      address:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
    }),
  }),
}));

vi.mock("@/lib/pk-bootstrap", () => ({
  ensurePaymentRegistry: vi.fn(async () => ({ ok: true, minted: false })),
}));

// `appendNaviSupply` and `appendPaymentKitReceipt` are only invoked
// on the sponsored branch — stub them so any accidental fall-through
// during the test doesn't blow up on uninitialised SDKs.
vi.mock("@/lib/navi-supply", () => ({
  appendNaviSupply: vi.fn(async () => undefined),
}));

vi.mock("@/lib/intents/wrap-payment-kit", () => ({
  appendPaymentKitReceipt: vi.fn(() => ({
    nonce: "tlse1abcd0001aaaaaabbbbbb",
  })),
}));

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

// The gasless branch builds offline on the gRPC client, then runs an
// explicit post-build `simulateTransaction` to validate the PTB.
// `$kind: "Transaction"` is the success discriminant; a test can drive a
// `FailedTransaction` via `simulateTransactionMock.mockResolvedValueOnce`.
const { simulateTransactionMock } = vi.hoisted(() => ({
  simulateTransactionMock: vi.fn(async () => ({ $kind: "Transaction" })),
}));

// Minimal Sui client stub. The gasless branch forwards the client into
// `tx.build({ client })` (the stubbed Transaction ignores it) and calls
// `client.simulateTransaction(...)`. `getReferenceGasPrice` is included
// in case the build path ever queries it (it currently doesn't, since
// the route pre-stamps `setGasPrice(0n)`).
vi.mock("@/lib/sui", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sui")>(
    "@/lib/sui"
  );
  return {
    ...actual,
    sui: () => ({
      getReferenceGasPrice: async () => ({ referenceGasPrice: "1000" }),
      simulateTransaction: simulateTransactionMock,
    }),
    network: () => "mainnet" as const,
  };
});

// The gasless build sets a ValidDuring expiration that needs the live
// epoch + the chain identifier — stub both so no network read happens.
vi.mock("@/lib/sui-epoch", () => ({
  getCurrentEpoch: vi.fn(async () => 1234),
  getChainIdentifier: vi.fn(async () => "test-chain"),
}));

// Stub the `Transaction` builder so `tx.build({ client })` returns a
// deterministic non-empty byte buffer. Mirrors the sponsored sibling
// test's stub so the two share a single contract surface.
vi.mock("@mysten/sui/transactions", async () => {
  const actual = await vi.importActual<typeof import("@mysten/sui/transactions")>(
    "@mysten/sui/transactions"
  );
  class StubTransaction {
    setSender = vi.fn();
    setGasOwner = vi.fn();
    setGasPrice = vi.fn();
    setGasBudget = vi.fn();
    // Empty-array gas payment — the load-bearing call that makes the
    // gRPC build go offline (skips the resolve-time simulate).
    setGasPayment = vi.fn();
    add = vi.fn(() => ({ kind: "Result" }));
    moveCall = vi.fn(() => ({ kind: "Result" }));
    transferObjects = vi.fn();
    object = vi.fn(() => ({ kind: "Input" }));
    // Canonical gasless primitive — pulls amount from Address Balance
    // accumulator. The route uses `tx.withdrawal({ amount, type })` as
    // the first argument to `0x2::balance::send_funds<T>`. Stub returns
    // an Argument-shaped value so `moveCall` accepts it.
    withdrawal = vi.fn(() => ({ kind: "Withdrawal" }));
    // Current gasless build pulls from the Address Balance accumulator
    // via `tx.balance({ type, balance })` and sets a ValidDuring
    // expiration. Both must exist on the stub or the build throws
    // "tx.balance is not a function".
    balance = vi.fn(() => ({ kind: "Balance" }));
    setExpiration = vi.fn();
    pure = {
      address: vi.fn(() => ({ kind: "Input" })),
    };
    build = vi.fn(async () => {
      // 16 deterministic bytes — enough to confirm "non-empty" and
      // round-trips cleanly through toBase64 / fromBase64.
      return new Uint8Array([
        10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160,
      ]);
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
const { setPendingRoundup } = await import("@/lib/perf-cache");

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

describe("/api/send/sponsor-prepare (gasless branch, PREPARE only)", () => {
  beforeEach(() => {
    // The route reads `process.env.ONARA_URL` at the top and 503s if
    // it's missing. Set a placeholder — the gasless branch never
    // actually calls Onara, but the env guard runs before branching.
    process.env.ONARA_URL = "http://onara.test";
    vi.clearAllMocks();
    // Default to roundup disabled so each test starts in gasless
    // territory unless it overrides explicitly.
    vi.mocked(getRoundupConfig).mockResolvedValue({
      enabled: false,
      percentage: 0,
      savedUsd: 0,
    });
  });

  it("plain USDsui send (amount 0.01) → { mode:'gasless', bytes, roundupUsd: 0 }", async () => {
    const res = await POST(
      buildReq({ to: RECIPIENT_ADDR, amount: 0.01, asset: "USDsui" })
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

    // All three contract fields from the brief.
    expect(json.mode).toBe("gasless");
    expect(typeof json.bytes).toBe("string");
    expect(json.bytes.length).toBeGreaterThan(0);
    expect(json.roundupUsd).toBe(0);

    // Echo fields — sanity, not contract.
    expect(json.asset).toBe("USDsui");
    expect(json.amount).toBe(0.01);
    expect(json.to).toBe(RECIPIENT_ADDR);
  });

  it("small USDsui amount (0.001) is rejected — Sui's gasless rail has a 0.01 USDsui minimum", async () => {
    // Sui validator-side rule (docs-confirmed):
    //   "All gasless stablecoin transfers have a minimum transfer
    //    balance of 0.01. Transfers below this minimum will not be
    //    executed."
    // 0.01 USDsui = 10,000 µ. The route rejects upfront with a clear
    // copy (BELOW_GASLESS_MINIMUM) instead of letting the validator
    // reject the tx ~1s later under an opaque "Invalid withdraw
    // reservation" string.
    const res = await POST(
      buildReq({ to: RECIPIENT_ADDR, amount: 0.001, asset: "USDsui" })
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as {
      error: string;
      code: string;
      minMicros: string;
    };
    expect(json.code).toBe("BELOW_GASLESS_MINIMUM");
    expect(json.minMicros).toBe("10000");
    expect(json.error).toMatch(/0\.01/);
  });

  it("gasless simulate FailedTransaction (accumulator underfunded) → 400 ACCUMULATOR_UNDERFUNDED", async () => {
    // The offline gRPC build always succeeds; the EXPLICIT post-build
    // simulate is what now catches an underfunded accumulator. A
    // FailedTransaction must surface the validator's reason
    // (effects.status.error.description) so the route categorizes it —
    // SnS off → a clean 400, and NO signable bytes handed back to iOS.
    simulateTransactionMock.mockResolvedValueOnce({
      $kind: "FailedTransaction",
      FailedTransaction: {
        effects: {
          status: {
            error: {
              description:
                "Invalid withdraw reservation. Gasless transactions must use the entire balance, or leave at least 10000 for token type USDSUI",
            },
          },
        },
      },
    } as never);
    const res = await POST(
      buildReq({ to: RECIPIENT_ADDR, amount: 0.5, asset: "USDsui" })
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string; error: string };
    expect(json.code).toBe("ACCUMULATOR_UNDERFUNDED");
    // The build must NOT have produced signable bytes.
    expect((json as { bytes?: string }).bytes).toBeUndefined();
  });

  // ─── Post 2026-05-29 product-directive tests ────────────────────
  //
  // The brief: every USDsui send takes the gasless rail, regardless
  // of Spend-and-Save state. When SnS is on, the rounded-up amount
  // is DEFERRED — sponsor-prepare stashes it via `setPendingRoundup`,
  // gasless-submit drains it into `roundup_queue` after broadcast,
  // and the cron worker (stubbed at /api/cron/process-roundup-queue)
  // executes the NAVI supply as a separate sponsored tx.

  it("USDsui with SnS on routes to the sponsored atomic-save path (mode 'sponsored')", async () => {
    // Option A (2026-06-01): a Save-on send can't ride the gasless rail (the
    // round-up NAVI supply can't co-bundle with `balance::send_funds`), so it
    // falls through to the sponsored branch, which bundles the transfer + the
    // NAVI supply ATOMICALLY in one user-signed tx. Plain sends stay gasless.
    vi.mocked(getRoundupConfig).mockResolvedValue({
      enabled: true,
      percentage: 5,
      savedUsd: 0,
    });
    const res = await POST(
      buildReq({ to: RECIPIENT_ADDR, amount: 1.0, asset: "USDsui" })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { mode: string; roundupUsd: number };
    expect(json.mode).toBe("sponsored");
    // 5% of 1.0 → 0.05, supplied to NAVI atomically in the same tx.
    expect(json.roundupUsd).toBeCloseTo(0.05, 6);
  });

  it("SnS on no longer defers the round-up — sponsored atomic path, no stash (option A)", async () => {
    // The old deferred model (stash via setPendingRoundup → roundup_queue →
    // cron) is RETIRED. A Save-on send routes sponsored and supplies NAVI
    // atomically in the same tx, so the deferred stash must NOT fire.
    vi.mocked(getRoundupConfig).mockResolvedValue({
      enabled: true,
      percentage: 10,
      savedUsd: 0,
    });
    const res = await POST(
      buildReq({ to: RECIPIENT_ADDR, amount: 2.5, asset: "USDsui" })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { mode: string; roundupUsd: number };
    expect(json.mode).toBe("sponsored");
    // 10% of 2.5 → 0.25, supplied to NAVI atomically (not deferred).
    expect(json.roundupUsd).toBeCloseTo(0.25, 6);
    // The dead deferred-stash path must NOT fire for a Save-on send.
    expect(setPendingRoundup).not.toHaveBeenCalled();
  });

  it("SUI transfer still takes sponsored rail (gasless is USDsui-only)", async () => {
    // gasless allowlist is stablecoin-only; SUI transfers continue
    // through the Onara sponsored path with no change.
    vi.mocked(getRoundupConfig).mockResolvedValue({
      enabled: false,
      percentage: 0,
      savedUsd: 0,
    });
    const res = await POST(
      buildReq({ to: RECIPIENT_ADDR, amount: 0.5, asset: "SUI" })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { mode: string; asset: string };
    expect(json.mode).toBe("sponsored");
    expect(json.asset).toBe("SUI");
  });

  it("bytes payload is valid base64 and decodes to a non-empty Uint8Array", async () => {
    const res = await POST(
      buildReq({ to: RECIPIENT_ADDR, amount: 0.01, asset: "USDsui" })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { bytes: string };

    // Standard base64 charset (the SDK uses `toBase64`, not URL-safe).
    expect(json.bytes).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);

    const decoded = fromBase64(json.bytes);
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(decoded.length).toBeGreaterThan(0);
  });
});
