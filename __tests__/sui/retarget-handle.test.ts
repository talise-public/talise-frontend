/**
 * Integration test for `/api/handle/retarget` — the Profile UI route
 * that replaces the manual `scripts/fix-suins-targets.mjs` runbook.
 *
 * Scope: route handler in isolation. We never hit Sui mainnet — the
 * SuiNS subname enumeration helper, the `SuinsClient.getNameRecord`
 * lookup, Onara status, and `tx.build` are all stubbed at module
 * load time.
 *
 * Branches asserted:
 *   1. PROBE — POST ?probe=1 returns `{ names: [...] }` with each
 *      name's `fromTarget` and an `alreadyAligned: false` flag when
 *      at least one name's current target diverges from the user's
 *      sui_address. No PTB bytes are built.
 *   2. BUILD — POST (no probe) returns `bytes` (non-empty base64) +
 *      `mode: "sponsored-retarget"` + the diff array. We confirm the
 *      mode label is exactly the one the iOS sheet keys off and the
 *      bytes round-trip cleanly through fromBase64.
 *   3. ALREADY ALIGNED — when every owned name already points at the
 *      user's wallet, both probe and build paths return
 *      `{ alreadyAligned: true, names: [...] }` with no `bytes`.
 *
 * The route's per-name `withTimeout` and outer 10s cap aren't
 * exercised here — they're guard rails, not branching logic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fromBase64 } from "@mysten/sui/utils";

// ─── Hoisted mocks ──────────────────────────────────────────────────

vi.mock("@/lib/mobile-sessions", () => ({
  readEntryIdFromRequest: vi.fn(async () => 42),
  isMobileRequest: vi.fn(() => true),
}));

vi.mock("@/lib/app-attest", () => ({
  requireAppAttestStructural: vi.fn(() => null),
}));

const USER_ADDR =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const OLD_ADDR =
  "0x9999999999999999999999999999999999999999999999999999999999999999";

vi.mock("@/lib/db", () => ({
  userById: vi.fn(async () => ({
    id: 42,
    google_sub: "test-sub",
    email: "test@example.com",
    name: "Test User",
    picture: null,
    sui_address: USER_ADDR,
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

// `findAllTaliseSubnamesForOwner` is the on-chain enumeration — we
// fully stub it so each test can dictate which names the user owns
// and what each name's current target is.
const findAllMock = vi.fn();
vi.mock("@/lib/suins-lookup", () => ({
  findAllTaliseSubnamesForOwner: (...a: unknown[]) => findAllMock(...a),
}));

// SuinsClient.getNameRecord — read per-name target. The route uses
// this under a 3s `withTimeout` to RE-read after the enumeration
// (defensive: the helper's read could be stale). Mock returns the
// same value the helper put in `targetAddress`, simulating a fresh
// successful read for every name.
const getNameRecordMock = vi.fn();
vi.mock("@/lib/suins-operator", () => ({
  suins: () => ({
    getNameRecord: (...a: unknown[]) => getNameRecordMock(...a),
  }),
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

vi.mock("@/lib/sui", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sui")>(
    "@/lib/sui"
  );
  return {
    ...actual,
    sui: () => ({
      getReferenceGasPrice: async () => ({ referenceGasPrice: "1000" }),
    }),
    network: () => "mainnet" as const,
  };
});

// Stub @mysten/suins's SuinsTransaction so the route's
// `setTargetAddress` calls are no-ops. The real class needs a live
// SuinsClient instance to resolve the parent registry object id —
// we don't have one here and don't need one.
vi.mock("@mysten/suins", async () => {
  const actual = await vi.importActual<typeof import("@mysten/suins")>(
    "@mysten/suins"
  );
  class StubSuinsTransaction {
    constructor() {}
    setTargetAddress = vi.fn();
  }
  return {
    ...actual,
    SuinsTransaction: StubSuinsTransaction,
  };
});

// Stub the Transaction class — same shape as send-sponsored.test.ts.
// `build({client})` returns a deterministic non-empty byte buffer so
// the build-path assertion can confirm bytes round-trip through
// fromBase64 cleanly.
vi.mock("@mysten/sui/transactions", async () => {
  const actual = await vi.importActual<typeof import("@mysten/sui/transactions")>(
    "@mysten/sui/transactions"
  );
  class StubTransaction {
    setSender = vi.fn();
    setGasOwner = vi.fn();
    setGasPrice = vi.fn();
    object = vi.fn((id: string) => ({ kind: "Input", id }));
    build = vi.fn(async () => {
      return new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    });
  }
  return {
    ...actual,
    Transaction: StubTransaction,
  };
});

// ─── Import AFTER mocks ─────────────────────────────────────────────
const { POST } = await import("@/app/api/handle/retarget/route");

function buildReq(probe: boolean): Request {
  const url = probe
    ? "http://localhost/api/handle/retarget?probe=1"
    : "http://localhost/api/handle/retarget";
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: "{}",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ONARA_URL = "http://onara.test";
});

describe("/api/handle/retarget", () => {
  it("probe path returns names + currentTargets without building a PTB", async () => {
    findAllMock.mockResolvedValue([
      {
        username: "alice",
        fullName: "alice.talise.sui",
        nftId: "0xnft_alice",
        targetAddress: OLD_ADDR,
      },
      {
        username: "bob",
        fullName: "bob.talise.sui",
        nftId: "0xnft_bob",
        targetAddress: USER_ADDR, // already aligned
      },
    ]);
    getNameRecordMock.mockImplementation(async (name: string) => {
      if (name === "alice.talise.sui") return { targetAddress: OLD_ADDR };
      if (name === "bob.talise.sui") return { targetAddress: USER_ADDR };
      return null;
    });

    const res = await POST(buildReq(true));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      alreadyAligned?: boolean;
      names?: Array<{ nft: string; name: string; fromTarget: string | null }>;
      bytes?: string;
      mode?: string;
      needUpdate?: number;
    };

    expect(json.alreadyAligned).toBe(false);
    expect(json.bytes).toBeUndefined();
    expect(json.mode).toBeUndefined();
    expect(json.names).toHaveLength(2);
    expect(json.needUpdate).toBe(1);
    const alice = json.names!.find((n) => n.name === "alice.talise.sui");
    const bob = json.names!.find((n) => n.name === "bob.talise.sui");
    expect(alice?.fromTarget).toBe(OLD_ADDR);
    expect(alice?.nft).toBe("0xnft_alice");
    expect(bob?.fromTarget).toBe(USER_ADDR);
  });

  it("build path returns sponsored-retarget bytes + mode 'sponsored-retarget'", async () => {
    findAllMock.mockResolvedValue([
      {
        username: "alice",
        fullName: "alice.talise.sui",
        nftId: "0xnft_alice",
        targetAddress: OLD_ADDR,
      },
    ]);
    getNameRecordMock.mockResolvedValue({ targetAddress: OLD_ADDR });

    const res = await POST(buildReq(false));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      bytes?: string;
      mode?: string;
      names?: Array<{ nft: string; name: string; fromTarget: string | null }>;
      sponsor?: string;
      gasPrice?: string;
      alreadyAligned?: boolean;
    };

    expect(json.mode).toBe("sponsored-retarget");
    expect(json.alreadyAligned).toBeFalsy();
    expect(typeof json.bytes).toBe("string");
    expect(json.bytes!.length).toBeGreaterThan(0);
    // Bytes round-trip cleanly through fromBase64 — what iOS will do
    // before signing.
    const decoded = fromBase64(json.bytes!);
    expect(decoded.length).toBeGreaterThan(0);
    expect(json.names).toHaveLength(1);
    expect(json.names![0].nft).toBe("0xnft_alice");
    expect(json.sponsor).toMatch(/^0x[0-9a-f]+$/i);
    expect(json.gasPrice).toBeDefined();
  });

  it("already-aligned path returns alreadyAligned: true with no PTB", async () => {
    findAllMock.mockResolvedValue([
      {
        username: "alice",
        fullName: "alice.talise.sui",
        nftId: "0xnft_alice",
        targetAddress: USER_ADDR,
      },
    ]);
    getNameRecordMock.mockResolvedValue({ targetAddress: USER_ADDR });

    // Build path — even without ?probe=1, when every name is aligned
    // the route returns alreadyAligned and never invokes Onara.
    const res = await POST(buildReq(false));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      alreadyAligned?: boolean;
      names?: Array<{ nft: string; name: string; fromTarget: string | null }>;
      bytes?: string;
      mode?: string;
    };

    expect(json.alreadyAligned).toBe(true);
    expect(json.bytes).toBeUndefined();
    expect(json.mode).toBeUndefined();
    expect(json.names).toHaveLength(1);
    expect(json.names![0].fromTarget).toBe(USER_ADDR);
  });
});
