/**
 * Tests for the `gasless-direct` rail — the split of
 * `/api/send/gasless-submit` into two cheap endpoints so iOS can
 * broadcast the signed tx to a Sui fullnode itself and skip the Vercel
 * hop on the slow leg.
 *
 *   1. `/api/zk/assemble-signature` — pure proof + signature assembly.
 *   2. `/api/send/gasless-confirm`   — post-broadcast rewards crediting.
 *      Idempotent on `{userId, digest}` via an in-memory 60s dedupe map.
 *
 * Spend + Save used to be part of this route's job (pop a stashed amount,
 * enqueue it for a cron to supply later). It isn't any more: the save is a
 * leg inside the send's own PTB, and a Save-ON send never takes the gasless
 * rail at all, so there is no round-up bookkeeping on this path to test.
 *
 * Scope: wiring only. We mock `assembleZkLoginSignature` and `awardForTx` —
 * the underlying behavior of those helpers is covered by their own tests
 * (and in the case of `assembleZkLoginSignature` is impossible to
 * exercise deterministically without a real zkLogin session).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Hoisted mocks ─────────────────────────────────────────────────

vi.mock("@/lib/mobile-sessions", () => ({
  readEntryIdFromRequest: vi.fn(async () => 42),
  isMobileRequest: vi.fn(() => true),
  mobileSigningContext: vi.fn(async () => ({
    jwt: "test-jwt",
    salt: "0",
  })),
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

vi.mock("@/lib/zksigner", () => ({
  assembleZkLoginSignature: vi.fn(async () => ({
    signature: "ZkLoginSig-base64-AAAA",
    proof: {
      proofPoints: { a: ["1"], b: [["2"]], c: ["3"] },
      issBase64Details: { value: "iss", indexMod4: 0 },
      headerBase64: "hdr",
      addressSeed: "seed-123",
    },
    isFresh: true,
  })),
  readSigningCookie: vi.fn(async () => ({ jwt: "test-jwt", salt: "0" })),
}));

vi.mock("@/lib/rewards/earn", () => ({
  awardForTx: vi.fn(async () => ({ points: 1 })),
}));

// ─── Import AFTER mocks ────────────────────────────────────────────

const { POST: assemblePOST } = await import(
  "@/app/api/zk/assemble-signature/route"
);
const { POST: confirmPOST } = await import(
  "@/app/api/send/gasless-confirm/route"
);
const { assembleZkLoginSignature } = await import("@/lib/zksigner");
const { awardForTx } = await import("@/lib/rewards/earn");

function buildReq(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify(body),
  });
}

// ─── /api/zk/assemble-signature ────────────────────────────────────

describe("/api/zk/assemble-signature", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assembleZkLoginSignature).mockResolvedValue({
      signature: "ZkLoginSig-base64-AAAA",
      proof: {
        proofPoints: { a: ["1"], b: [["2"]], c: ["3"] },
        issBase64Details: { value: "iss", indexMod4: 0 },
        headerBase64: "hdr",
        addressSeed: "seed-123",
      },
      isFresh: true,
    });
  });

  it("returns signature + freshProof + proofMs for a well-formed body", async () => {
    const res = await assemblePOST(
      buildReq("/api/zk/assemble-signature", {
        bytesB64: "AAECAwQ=",
        ephemeralPubKeyB64: "ZXBoZW1lcmFs",
        maxEpoch: 1000,
        randomness: "rand-123",
        userSignature: "user-sig-base64",
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      signature: string;
      freshProof?: { addressSeed: string };
      proofMs: number;
    };
    expect(json.signature).toBe("ZkLoginSig-base64-AAAA");
    expect(json.freshProof?.addressSeed).toBe("seed-123");
    expect(typeof json.proofMs).toBe("number");
    expect(json.proofMs).toBeGreaterThanOrEqual(0);
  });

  it("omits freshProof when the proof came from cache (isFresh=false)", async () => {
    vi.mocked(assembleZkLoginSignature).mockResolvedValueOnce({
      signature: "ZkLoginSig-base64-CACHED",
      proof: {
        proofPoints: { a: ["1"], b: [["2"]], c: ["3"] },
        issBase64Details: { value: "iss", indexMod4: 0 },
        headerBase64: "hdr",
        addressSeed: "seed-123",
      },
      isFresh: false,
    });
    const res = await assemblePOST(
      buildReq("/api/zk/assemble-signature", {
        bytesB64: "AAECAwQ=",
        ephemeralPubKeyB64: "ZXBoZW1lcmFs",
        maxEpoch: 1000,
        randomness: "rand-123",
        userSignature: "user-sig-base64",
        cachedProof: {
          proofPoints: { a: ["1"], b: [["2"]], c: ["3"] },
          issBase64Details: { value: "iss", indexMod4: 0 },
          headerBase64: "hdr",
          addressSeed: "seed-123",
        },
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      signature: string;
      freshProof?: unknown;
    };
    expect(json.signature).toBe("ZkLoginSig-base64-CACHED");
    expect(json.freshProof).toBeUndefined();
  });

  it("rejects with 400 on missing fields", async () => {
    const res = await assemblePOST(
      buildReq("/api/zk/assemble-signature", {
        // Missing ephemeralPubKeyB64, maxEpoch, randomness, userSignature.
        bytesB64: "AAECAwQ=",
      })
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/missing fields/);
    expect(assembleZkLoginSignature).not.toHaveBeenCalled();
  });
});

// ─── /api/send/gasless-confirm ─────────────────────────────────────

describe("/api/send/gasless-confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("awards rewards exactly once on duplicate confirms", async () => {
    // Unique digest per test so the in-memory dedupe map (which lives
    // for the lifetime of the module) doesn't false-positive against
    // a prior test's confirm.
    const digest = `idem-${Date.now()}-${Math.random()}`;

    const body = {
      digest,
      meta: { kind: "send", amountUsd: 12.5, venue: "talise" },
    };

    // 1st confirm — should do the full bookkeeping.
    const res1 = await confirmPOST(
      buildReq("/api/send/gasless-confirm", body)
    );
    expect(res1.status).toBe(204);

    // 2nd confirm — same digest, should be a fast 204 no-op.
    const res2 = await confirmPOST(
      buildReq("/api/send/gasless-confirm", body)
    );
    expect(res2.status).toBe(204);

    // Flush microtasks so the fire-and-forget award is observable.
    await new Promise((resolve) => setImmediate(resolve));

    // awardForTx must fire exactly once across both confirms.
    // The earn helper docs explicitly say it doesn't dedupe by digest
    // (web/lib/rewards/earn.ts:62), so the dedupe MUST happen at the
    // route level — that's what this assertion proves.
    expect(awardForTx).toHaveBeenCalledTimes(1);
    expect(awardForTx).toHaveBeenCalledWith({
      userId: 42,
      trigger: "send",
      amountUsd: 12.5,
      digest,
      venue: "talise",
    });
  });

  it("rejects 400 when digest is missing", async () => {
    const res = await confirmPOST(
      buildReq("/api/send/gasless-confirm", {
        meta: { kind: "send", amountUsd: 1 },
      })
    );
    expect(res.status).toBe(400);
    expect(awardForTx).not.toHaveBeenCalled();
  });
});
