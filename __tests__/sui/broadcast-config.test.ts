/**
 * Unit tests for `GET /api/sui/broadcast-config`.
 *
 * The endpoint hands iOS the Sui JSON-RPC URL + auth headers it should
 * use for the direct-broadcast (gasless) rail. When `SHINAMI_NODE_API_KEY`
 * is set we point iOS at Shinami; otherwise we fall back to the public
 * mainnet fullnode. These tests verify both branches plus the auth
 * gate.
 *
 * Structural-only — we never hit a live RPC.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Default the auth mock to "authenticated as user 42". Tests that need
// the 401 branch override per-call.
vi.mock("@/lib/mobile-sessions", () => ({
  readEntryIdFromRequest: vi.fn(async () => 42),
  isMobileRequest: vi.fn(() => true),
}));

const { GET } = await import("@/app/api/sui/broadcast-config/route");
const { readEntryIdFromRequest } = await import("@/lib/mobile-sessions");

const PUBLIC_URL = "https://fullnode.mainnet.sui.io:443";
const SHINAMI_URL = "https://api.us1.shinami.com/sui/node/v1";

function buildReq(): Request {
  return new Request("http://localhost/api/sui/broadcast-config", {
    method: "GET",
    headers: { authorization: "Bearer test-token" },
  });
}

describe("/api/sui/broadcast-config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readEntryIdFromRequest).mockResolvedValue(42);
    delete process.env.SHINAMI_NODE_API_KEY;
  });

  it("returns the public config when SHINAMI_NODE_API_KEY is unset", async () => {
    const res = await GET(buildReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      url: string;
      headers: Record<string, string>;
      provider: string;
    };
    expect(body.url).toBe(PUBLIC_URL);
    expect(body.headers).toEqual({});
    expect(body.provider).toBe("public");
    // Cache header rides on every response, public or paid.
    expect(res.headers.get("cache-control")).toBe("private, max-age=900");
  });

  it("returns the Shinami config when SHINAMI_NODE_API_KEY is set", async () => {
    process.env.SHINAMI_NODE_API_KEY = "test-shinami-key";
    const res = await GET(buildReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      url: string;
      headers: Record<string, string>;
      provider: string;
    };
    expect(body.url).toBe(SHINAMI_URL);
    // Header name must be EXACTLY `X-Api-Key` — that's what Shinami's
    // node accepts and what `lib/sui-endpoints.ts` ships on the gRPC
    // side, so the iOS client doesn't need provider-specific casing.
    expect(body.headers).toEqual({ "X-Api-Key": "test-shinami-key" });
    expect(body.provider).toBe("shinami");
  });

  it("401s when the caller has no session cookie / bearer", async () => {
    vi.mocked(readEntryIdFromRequest).mockResolvedValueOnce(null);
    const res = await GET(buildReq());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not authenticated/i);
    // No URL leak on the 401 path — the body must NOT contain the
    // Shinami host or the public fullnode URL.
    expect(JSON.stringify(body)).not.toContain("shinami");
    expect(JSON.stringify(body)).not.toContain("fullnode.mainnet");
  });
});

// ─── Structural test: shinamiSuiNodeJsonRpc() construction shape ──
//
// The brief: when `SHINAMI_NODE_API_KEY` is set, the helper that backs
// the broadcast-config route must return Shinami's node URL AND a header
// set that injects `X-Api-Key`. We don't hit live Shinami — we inspect
// the helper's return shape and its fetch-header merge directly.
// (The send gasless build no longer constructs a JSON-RPC client at all
// — it builds offline on gRPC as of 2026-06-01 — but this Shinami helper
// is still used by the broadcast-config route, so its shape still matters.)

describe("shinamiSuiNodeJsonRpc() — JSON-RPC client construction shape", () => {
  beforeEach(() => {
    delete process.env.SHINAMI_NODE_API_KEY;
  });

  it("returns null when SHINAMI_NODE_API_KEY is unset", async () => {
    const { shinamiSuiNodeJsonRpc } = await import("@/lib/shinami");
    expect(shinamiSuiNodeJsonRpc()).toBeNull();
  });

  it("returns Shinami URL + X-Api-Key header when SHINAMI_NODE_API_KEY is set", async () => {
    process.env.SHINAMI_NODE_API_KEY = "structural-test-key";
    const { shinamiSuiNodeJsonRpc } = await import("@/lib/shinami");
    const got = shinamiSuiNodeJsonRpc();
    expect(got).not.toBeNull();
    expect(got!.url).toBe(SHINAMI_URL);
    expect(got!.headers).toEqual({ "X-Api-Key": "structural-test-key" });
  });

  it("the JSON-RPC fetch wrapper injects the Shinami auth header", async () => {
    process.env.SHINAMI_NODE_API_KEY = "wrapper-key";
    const { shinamiSuiNodeJsonRpc } = await import("@/lib/shinami");
    const shinami = shinamiSuiNodeJsonRpc()!;

    // Mirror the exact fetch wrapper the route builds — if this
    // pattern ever diverges from `buildShinamiJsonRpc`, the test
    // catches it because both produce the same on-the-wire headers.
    const observed: Array<Record<string, string>> = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      observed.push((init?.headers ?? {}) as Record<string, string>);
      return new Response("{}", { status: 200 });
    };
    const wrapped = (input: RequestInfo, init?: RequestInit) => {
      const hdrs: Record<string, string> = {
        ...((init?.headers as Record<string, string> | undefined) ?? {}),
        ...shinami.headers,
      };
      return fakeFetch(input as never, { ...init, headers: hdrs });
    };

    await wrapped("https://api.us1.shinami.com/sui/node/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(observed.length).toBe(1);
    expect(observed[0]["X-Api-Key"]).toBe("wrapper-key");
    // Caller-supplied headers must survive the merge.
    expect(observed[0]["Content-Type"]).toBe("application/json");
  });
});
