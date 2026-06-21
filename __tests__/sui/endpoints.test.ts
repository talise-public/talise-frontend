/**
 * Unit test for `web/lib/sui-endpoints.ts`.
 *
 * Verifies the fallback wrapper:
 *   1. Returns success from endpoint #1 when it succeeds.
 *   2. Falls back to endpoint #2 when endpoint #1 throws an `UNAVAILABLE`
 *      gRPC error (the today's-outage scenario).
 *   3. Re-throws non-retryable errors instead of blowing through every
 *      provider.
 *
 * The wrapper is exercised by patching `process.env` so only the public
 * endpoints (no auth required) get attempted, and by intercepting
 * `SuiGrpcClient` via vitest's `vi.mock`. We don't talk to mainnet here —
 * the broken-mainnet integration tests stay broken; this one verifies the
 * fallback layer itself.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @mysten/sui/grpc BEFORE the wrapper imports it so every
// `new SuiGrpcClient(...)` inside the wrapper instantiates our fake.
// `vi.hoisted` ensures these references are initialized before the
// hoisted `vi.mock` factory runs.
const { ctorCalls, FakeSuiGrpcClient } = vi.hoisted(() => {
  const ctorCalls: Array<{ baseUrl: string; meta?: Record<string, string> }> = [];
  class FakeSuiGrpcClient {
    public readonly baseUrl: string;
    public readonly meta?: Record<string, string>;
    // Sentinel mutable map keyed by baseUrl — tests set responses here to
    // control what each fake client's `.tag()` returns.
    static responses = new Map<string, () => Promise<unknown>>();
    constructor(opts: { baseUrl: string; meta?: Record<string, string>; network: string }) {
      this.baseUrl = opts.baseUrl;
      this.meta = opts.meta;
      ctorCalls.push({ baseUrl: opts.baseUrl, meta: opts.meta });
    }
    // The test passes a function that calls `client.tag()`; the fake
    // delegates to whatever the test registered under `baseUrl`.
    async tag(): Promise<unknown> {
      const fn = FakeSuiGrpcClient.responses.get(this.baseUrl);
      if (!fn) throw new Error(`no response registered for ${this.baseUrl}`);
      return fn();
    }
  }
  return { ctorCalls, FakeSuiGrpcClient };
});

vi.mock("@mysten/sui/grpc", () => ({
  SuiGrpcClient: FakeSuiGrpcClient,
}));

// Import AFTER the mock so the wrapper picks up the fake constructor.
import {
  suiGrpcWithFallback,
  MAINNET_GRPC_ENDPOINTS,
  isFallbackEligible,
} from "../../lib/sui-endpoints";

const PRIMARY_URL = "https://fullnode.mainnet.sui.io:443";
// The dead `archive.mainnet.sui.io` host was removed from the registry
// (it 404s the gRPC service), so the second endpoint in the chain is now
// the first KEYED provider. We set SHINAMI_API_KEY in the fallback tests so
// Shinami becomes endpoint #2 and the wrapper has a real second hop.
const SECONDARY_URL = "https://api.us1.shinami.com/sui/node/v1";

function unavailableError(): Error {
  // Mimic `@protobuf-ts/runtime-rpc/RpcError`: an Error subclass with a
  // string `code` field set to one of the gRPC status names.
  const err = new Error("upstream connect error or disconnect/reset before headers. reset reason: connection failure");
  (err as Error & { code: string }).code = "UNAVAILABLE";
  return err;
}

function deadlineError(): Error {
  const err = new Error("deadline exceeded");
  (err as Error & { code: string }).code = "DEADLINE_EXCEEDED";
  return err;
}

function fatalError(): Error {
  const err = new Error("InvalidArgument: address must be a hex string");
  (err as Error & { code: string }).code = "INVALID_ARGUMENT";
  return err;
}

describe("sui-endpoints fallback wrapper", () => {
  beforeEach(() => {
    ctorCalls.length = 0;
    FakeSuiGrpcClient.responses.clear();
    // Deterministic two-endpoint chain: the public fullnode (#1, no key) then
    // Shinami (#2). We set a dummy SHINAMI_API_KEY so Shinami is constructed
    // as the fallback target — the FakeSuiGrpcClient ignores auth, it just
    // records the URL + meta. (The dead `archive.mainnet.sui.io` host that
    // used to sit at #2 was removed from the registry.) Dwellir / QuickNode
    // stay unkeyed so they're skipped and don't perturb the chain.
    process.env.SHINAMI_API_KEY = "test-shinami-key";
    delete process.env.DWELLIR_API_KEY;
    delete process.env.QUICKNODE_SUI_GRPC_URL;
    // Wrapper hard-fails on testnet today.
    process.env.NEXT_PUBLIC_SUI_NETWORK = "mainnet";
  });

  it("returns the result from the first endpoint when it succeeds", async () => {
    FakeSuiGrpcClient.responses.set(PRIMARY_URL, async () => ({ ok: true, from: "primary" }));
    const result = await suiGrpcWithFallback((c) =>
      (c as unknown as { tag: () => Promise<unknown> }).tag(),
    );
    expect(result).toEqual({ ok: true, from: "primary" });
    // Only the first endpoint should have been instantiated.
    expect(ctorCalls.length).toBe(1);
    expect(ctorCalls[0].baseUrl).toBe(PRIMARY_URL);
  });

  it("falls back to the second endpoint when the first throws UNAVAILABLE", async () => {
    FakeSuiGrpcClient.responses.set(PRIMARY_URL, async () => {
      throw unavailableError();
    });
    FakeSuiGrpcClient.responses.set(SECONDARY_URL, async () => ({ ok: true, from: "secondary" }));

    const result = await suiGrpcWithFallback((c) =>
      (c as unknown as { tag: () => Promise<unknown> }).tag(),
    );
    expect(result).toEqual({ ok: true, from: "secondary" });
    // Wrapper attempted primary, failed, then constructed and called secondary.
    expect(ctorCalls.length).toBeGreaterThanOrEqual(2);
    expect(ctorCalls[0].baseUrl).toBe(PRIMARY_URL);
    expect(ctorCalls[1].baseUrl).toBe(SECONDARY_URL);
  });

  it("also falls back on DEADLINE_EXCEEDED", async () => {
    FakeSuiGrpcClient.responses.set(PRIMARY_URL, async () => {
      throw deadlineError();
    });
    FakeSuiGrpcClient.responses.set(SECONDARY_URL, async () => ({ ok: true, from: "secondary" }));
    const result = await suiGrpcWithFallback((c) =>
      (c as unknown as { tag: () => Promise<unknown> }).tag(),
    );
    expect(result).toEqual({ ok: true, from: "secondary" });
  });

  it("re-throws non-retryable errors instead of fanning out", async () => {
    FakeSuiGrpcClient.responses.set(PRIMARY_URL, async () => {
      throw fatalError();
    });
    // Wire secondary too so we can prove it was NOT consulted.
    FakeSuiGrpcClient.responses.set(SECONDARY_URL, async () => ({ ok: true }));

    await expect(
      suiGrpcWithFallback((c) => (c as unknown as { tag: () => Promise<unknown> }).tag()),
    ).rejects.toThrow(/InvalidArgument/);

    // Only the primary should have been built.
    expect(ctorCalls.length).toBe(1);
    expect(ctorCalls[0].baseUrl).toBe(PRIMARY_URL);
  });

  it("registry lists at least one free public Mysten endpoint first", () => {
    expect(MAINNET_GRPC_ENDPOINTS.length).toBeGreaterThan(0);
    const first = MAINNET_GRPC_ENDPOINTS[0];
    expect(first.url).toBe(PRIMARY_URL);
    expect(first.requiresAuth).toBe(false);
  });

  it("no longer lists the dead archive.mainnet.sui.io host", () => {
    // Regression guard: the archive host 404s the gRPC service and must
    // never re-enter the chain (it would break fallback during an outage).
    for (const ep of MAINNET_GRPC_ENDPOINTS) {
      expect(ep.url).not.toContain("archive.mainnet.sui.io");
    }
  });

  it("isFallbackEligible flags 503 / no_healthy_upstream messages", () => {
    expect(isFallbackEligible(new Error("503 no_healthy_upstream"))).toBe(true);
    expect(isFallbackEligible(new Error("fetch failed"))).toBe(true);
    expect(isFallbackEligible(unavailableError())).toBe(true);
    expect(isFallbackEligible(new Error("nope, address invalid"))).toBe(false);
  });

  it("isFallbackEligible treats a transport-level NOT_FOUND/UNIMPLEMENTED as eligible", () => {
    // The dead archive host throws `RpcError { code: "NOT_FOUND",
    // message: "Not Found" }` for every method — a per-endpoint capability
    // failure, so we must skip to the next provider rather than throw.
    const notFound = new Error("Not Found");
    (notFound as Error & { code: string }).code = "NOT_FOUND";
    expect(isFallbackEligible(notFound)).toBe(true);

    const unimplemented = new Error("Unimplemented");
    (unimplemented as Error & { code: string }).code = "UNIMPLEMENTED";
    expect(isFallbackEligible(unimplemented)).toBe(true);

    // Numeric gRPC status forms too (5 = NOT_FOUND, 12 = UNIMPLEMENTED).
    const numericNotFound = new Error("not found");
    (numericNotFound as Error & { code: number }).code = 5;
    expect(isFallbackEligible(numericNotFound)).toBe(true);
  });

  it("does NOT fan out on a legitimate missing-object error (no transport code)", () => {
    // A real fullnode returns a descriptive message with NO `.code` field
    // for a missing object. That must stay non-eligible so we don't blow
    // through every provider on a benign not-found result.
    const missingObj = new Error(
      "Object 0x00000000000000000000000000000000000000000000000000000000deadbeef not found"
    );
    expect(isFallbackEligible(missingObj)).toBe(false);
  });

  it("walks PAST a NOT_FOUND endpoint to the next healthy one", async () => {
    // End-to-end: simulate the post-fix outage shape. The public fullnode
    // (#1) is down (UNAVAILABLE) AND the next attempt hits a host that 404s
    // the gRPC service (NOT_FOUND). The wrapper must keep going and resolve
    // on a later endpoint rather than throwing "Not Found". We add a third
    // keyed provider (Dwellir) as the eventual healthy hop.
    process.env.DWELLIR_API_KEY = "test-dwellir-key";
    const DWELLIR_URL = "https://api-sui-mainnet-full.n.dwellir.com:443";

    FakeSuiGrpcClient.responses.set(PRIMARY_URL, async () => {
      throw unavailableError();
    });
    const notFound = new Error("Not Found");
    (notFound as Error & { code: string }).code = "NOT_FOUND";
    FakeSuiGrpcClient.responses.set(SECONDARY_URL, async () => {
      throw notFound;
    });
    FakeSuiGrpcClient.responses.set(DWELLIR_URL, async () => ({
      ok: true,
      from: "dwellir",
    }));

    const result = await suiGrpcWithFallback((c) =>
      (c as unknown as { tag: () => Promise<unknown> }).tag()
    );
    expect(result).toEqual({ ok: true, from: "dwellir" });
    // All three were constructed, in order.
    expect(ctorCalls.map((c) => c.baseUrl)).toEqual([
      PRIMARY_URL,
      SECONDARY_URL,
      DWELLIR_URL,
    ]);
  });
});
