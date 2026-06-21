/**
 * Smoke + core-read tests for the Sui gRPC integration against real mainnet.
 *
 * The harness wiring (`getObject` via gRPC) is the canary: if it passes, the
 * gRPC transport is healthy. On top of that we assert the three core read
 * paths the app leans on — `getReferenceGasPrice` (gas budgeting),
 * `getServiceInfo().chainId` (chain-identity / network guard), and
 * `getBalance` (the balance hero) — plus the multi-endpoint fallback wrapper
 * recovering when the primary endpoint is forced to fail.
 *
 * All assertions verify SHAPE + chain identity, not volatile values, so they
 * survive balance churn between runs.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getGrpcClient,
  KNOWN_MAINNET_ADDRESS,
  ACTIVE_MAINNET_ADDRESS,
  MAINNET_CHAIN_IDENTIFIER,
} from "./harness";
import {
  suiGrpcWithFallback,
  isFallbackEligible,
} from "../../lib/sui-endpoints";

describe("sui integration harness", () => {
  it("can fetch the system state object via gRPC", async () => {
    const client = getGrpcClient();
    const res = await client.getObject({ objectId: KNOWN_MAINNET_ADDRESS });
    expect(res).not.toBeNull();
    expect(res).toBeDefined();
    expect(res.object).toBeDefined();
    expect(res.object.objectId).toBe(KNOWN_MAINNET_ADDRESS);
  }, 30_000);
});

describe("sui gRPC core reads (mainnet)", () => {
  it("getReferenceGasPrice returns a positive integer-string", async () => {
    const client = getGrpcClient();
    const res = await client.getReferenceGasPrice();
    // gRPC shape: `{ referenceGasPrice: string }` (MIST per gas unit).
    expect(res).toBeDefined();
    expect(typeof res.referenceGasPrice).toBe("string");
    const gp = BigInt(res.referenceGasPrice);
    // Mainnet RGP has been >= 1 (typically 100..1000) for the life of the
    // network. Assert positivity rather than a fixed value so we don't
    // break when the validators bump it.
    expect(gp > 0n).toBe(true);
  }, 30_000);

  it("getServiceInfo exposes the mainnet chainId (getChainIdentifier)", async () => {
    const client = getGrpcClient();
    // The SDK has no top-level `getChainIdentifier`; the chain identifier
    // lives on `ledgerService.getServiceInfo().response.chainId`. This is
    // the gRPC equivalent of GraphQL's `chainIdentifier` field.
    const info = await client.ledgerService.getServiceInfo({});
    // The proto types mark these optional; assert presence then narrow.
    const chainId = info.response.chainId;
    expect(typeof chainId).toBe("string");
    expect((chainId ?? "").length).toBeGreaterThan(0);
    // Must be MAINNET — guards against a config slip pointing the harness
    // (or the app) at testnet/devnet.
    expect(chainId).toBe(MAINNET_CHAIN_IDENTIFIER);
    expect(info.response.chain).toBe("mainnet");
    // Epoch is a u64 surfaced as bigint by the SDK; assert it's advancing.
    const epoch = info.response.epoch;
    expect(epoch).toBeDefined();
    expect(BigInt(epoch ?? 0n) > 0n).toBe(true);
  }, 30_000);

  it("getBalance returns the canonical SUI balance shape for a known address", async () => {
    const client = getGrpcClient();
    // 0x2 (the Sui framework) holds SUI and is permanent, so this is a
    // stable target for a non-zero balance read.
    const res = await client.getBalance({ owner: ACTIVE_MAINNET_ADDRESS });
    expect(res.balance).toBeDefined();
    // gRPC normalizes the coin type to its full 0x000…002 form.
    expect(res.balance.coinType).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
    );
    // `balance` is the u64 total as a decimal string. Must parse as a
    // non-negative BigInt (no precision loss for large balances).
    expect(typeof res.balance.balance).toBe("string");
    const mist = BigInt(res.balance.balance);
    expect(mist >= 0n).toBe(true);
  }, 30_000);

  it("getBalance honors an explicit coinType filter", async () => {
    const client = getGrpcClient();
    const res = await client.getBalance({
      owner: ACTIVE_MAINNET_ADDRESS,
      coinType: "0x2::sui::SUI",
    });
    // Even when the caller passes the short type, the response echoes the
    // full normalized form — the exact behaviour `lib/sui.ts` balance
    // helpers rely on when reading `res.balance.balance`.
    expect(res.balance.coinType).toContain("::sui::SUI");
    expect(typeof res.balance.balance).toBe("string");
  }, 30_000);
});

describe("suiGrpcWithFallback (live mainnet recovery)", () => {
  beforeEach(() => {
    // Deterministic, auth-free run: drop any provider keys so only the two
    // free public Mysten endpoints participate in the chain.
    delete process.env.SHINAMI_API_KEY;
    delete process.env.DWELLIR_API_KEY;
    delete process.env.QUICKNODE_SUI_GRPC_URL;
    process.env.NEXT_PUBLIC_SUI_NETWORK = "mainnet";
  });

  it("runs a real read through the fallback wrapper (primary healthy)", async () => {
    // Happy path: the primary endpoint is up, so the wrapper resolves on
    // the first attempt with real mainnet data.
    const gp = await suiGrpcWithFallback((c) => c.getReferenceGasPrice());
    expect(typeof gp.referenceGasPrice).toBe("string");
    expect(BigInt(gp.referenceGasPrice) > 0n).toBe(true);
  }, 30_000);

  it("classifies a forced UNAVAILABLE as fallback-eligible and exhausts the chain", async () => {
    // Simulate the 2026-05-28 outage against the REAL endpoint construction:
    // every attempt throws an UNAVAILABLE-class error (exactly as the public
    // fullnode did when it returned `503 no_healthy_upstream`). With only the
    // single FREE public endpoint configured (the keyed providers need API
    // keys we don't have here), the wrapper should classify the error as
    // fallback-eligible, walk the whole chain, and — having no healthy hop —
    // surface that SAME error rather than swallowing it or throwing the
    // generic "no endpoints attempted" message. That proves the
    // classification + walk + last-error-propagation path end-to-end. The
    // multi-endpoint RECOVERY (advancing to a healthy hop) is proven against
    // mocked clients in `endpoints.test.ts`, which can stand up >1 endpoint
    // deterministically without paid keys.
    const failed = new Error(
      "upstream connect error or disconnect/reset before headers. reset reason: connection failure"
    );
    (failed as Error & { code: string }).code = "UNAVAILABLE";
    expect(isFallbackEligible(failed)).toBe(true);

    let attempts = 0;
    await expect(
      suiGrpcWithFallback(async () => {
        attempts += 1;
        throw failed;
      })
    ).rejects.toThrow(/upstream connect error|connection failure/);
    // At least the public fullnode was attempted.
    expect(attempts).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("recovers to a healthy endpoint when an unhealthy one precedes it (live)", async () => {
    // Genuine LIVE recovery: we hand the wrapper a chain whose FIRST hop
    // throws on its first invocation and whose SECOND hop is a real call to
    // the public fullnode. We get a real second hop without paid keys by
    // setting QUICKNODE_SUI_GRPC_URL to the public fullnode AND re-importing
    // the endpoints module so the registry re-reads the env (the QuickNode
    // slot's URL is captured at module-eval time).
    process.env.QUICKNODE_SUI_GRPC_URL =
      "https://fullnode.mainnet.sui.io:443";
    vi.resetModules();
    const { suiGrpcWithFallback: freshFallback } = await import(
      "../../lib/sui-endpoints"
    );

    const failed = new Error("no_healthy_upstream");
    (failed as Error & { code: string }).code = "UNAVAILABLE";

    let attempt = 0;
    try {
      const gp = await freshFallback(async (c) => {
        attempt += 1;
        if (attempt === 1) throw failed; // first endpoint "down"
        return c.getReferenceGasPrice(); // second endpoint = live fullnode
      });
      expect(attempt).toBeGreaterThanOrEqual(2);
      expect(typeof gp.referenceGasPrice).toBe("string");
      expect(BigInt(gp.referenceGasPrice) > 0n).toBe(true);
    } finally {
      delete process.env.QUICKNODE_SUI_GRPC_URL;
      vi.resetModules();
    }
  }, 30_000);
});
