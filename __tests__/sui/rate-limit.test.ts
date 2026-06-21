/**
 * Rate-limiter tests (audit F3 — global cross-instance caps).
 *
 * Hermetic: no live Redis, no network. We exercise both backends:
 *   1. Upstash env UNSET → falls back to the in-memory Map and still
 *      enforces the window (N allowed, N+1 blocked).
 *   2. Upstash env SET → `fetch` is mocked to simulate Upstash's
 *      INCR/EXPIRE/TTL REST responses; under limit allows, over blocks.
 *   3. Redis error → FAILS OPEN (allows) rather than 500-ing.
 *
 * Each scenario uses `vi.resetModules()` + a dynamic import so the
 * module-scope state (the in-memory Map, the "mode logged once" flag) is
 * fresh and the env snapshot is read at import time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REDIS_URL = "https://fake-upstash.example.com";
const REDIS_TOKEN = "fake-token";

function clearUpstashEnv() {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

async function loadModule() {
  vi.resetModules();
  return import("@/lib/rate-limit");
}

describe("rate-limit", () => {
  const origUrl = process.env.UPSTASH_REDIS_REST_URL;
  const origToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  beforeEach(() => {
    vi.restoreAllMocks();
    clearUpstashEnv();
  });

  afterEach(() => {
    if (origUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = origUrl;
    else delete process.env.UPSTASH_REDIS_REST_URL;
    if (origToken !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = origToken;
    else delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  describe("in-memory fallback (Upstash UNSET)", () => {
    it("sync rateLimit allows N then blocks N+1 in one window", async () => {
      const { rateLimit } = await loadModule();
      const opts = { key: "test:sync", limit: 3, windowSec: 60 };
      expect(rateLimit(opts).ok).toBe(true); // 1
      expect(rateLimit(opts).ok).toBe(true); // 2
      expect(rateLimit(opts).ok).toBe(true); // 3
      const blocked = rateLimit(opts); // 4
      expect(blocked.ok).toBe(false);
      expect(blocked.retryAfterSec).toBeGreaterThan(0);
    });

    it("rateLimitAsync falls back to in-memory and enforces the window", async () => {
      const { rateLimitAsync } = await loadModule();
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const opts = { key: "test:async-fallback", limit: 2, windowSec: 60 };
      expect((await rateLimitAsync(opts)).ok).toBe(true); // 1
      expect((await rateLimitAsync(opts)).ok).toBe(true); // 2
      const blocked = await rateLimitAsync(opts); // 3
      expect(blocked.ok).toBe(false);
      // Fallback must NOT touch the network.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("separate keys have independent buckets", async () => {
      const { rateLimit } = await loadModule();
      expect(rateLimit({ key: "a", limit: 1, windowSec: 60 }).ok).toBe(true);
      expect(rateLimit({ key: "a", limit: 1, windowSec: 60 }).ok).toBe(false);
      // Different key — fresh bucket.
      expect(rateLimit({ key: "b", limit: 1, windowSec: 60 }).ok).toBe(true);
    });
  });

  describe("Upstash REST backend (env SET)", () => {
    beforeEach(() => {
      process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
      process.env.UPSTASH_REDIS_REST_TOKEN = REDIS_TOKEN;
    });

    /** Build a fetch mock backed by an in-test INCR counter. */
    function mockUpstash(counterRef: { n: number }, ttl = 42) {
      return vi.spyOn(globalThis, "fetch").mockImplementation(
        async (_url: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as (string | number)[];
          const cmd = body[0];
          let result: unknown;
          if (cmd === "INCR") result = ++counterRef.n;
          else if (cmd === "EXPIRE") result = 1;
          else if (cmd === "TTL") result = ttl;
          else result = null;
          return new Response(JSON.stringify({ result }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      );
    }

    it("INCR path allows while count <= limit, blocks once over", async () => {
      const { rateLimitAsync } = await loadModule();
      const counter = { n: 0 };
      const fetchSpy = mockUpstash(counter, 30);
      const opts = { key: "test:redis", limit: 2, windowSec: 60 };

      expect((await rateLimitAsync(opts)).ok).toBe(true); // count 1
      expect((await rateLimitAsync(opts)).ok).toBe(true); // count 2
      const blocked = await rateLimitAsync(opts); // count 3 > 2
      expect(blocked.ok).toBe(false);
      expect(blocked.retryAfterSec).toBe(30); // from mocked TTL

      // Hit the REST endpoint (not the in-memory Map).
      expect(fetchSpy).toHaveBeenCalled();
      const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(urls.every((u) => u === REDIS_URL)).toBe(true);
    });

    it("calls EXPIRE only on the first hit of a window", async () => {
      const { rateLimitAsync } = await loadModule();
      const counter = { n: 0 };
      const fetchSpy = mockUpstash(counter);
      const opts = { key: "test:expire-once", limit: 5, windowSec: 60 };

      await rateLimitAsync(opts);
      await rateLimitAsync(opts);

      const commands = fetchSpy.mock.calls.map(
        (c) => JSON.parse(String((c[1] as RequestInit).body))[0]
      );
      expect(commands.filter((cmd) => cmd === "EXPIRE")).toHaveLength(1);
      expect(commands.filter((cmd) => cmd === "INCR")).toHaveLength(2);
    });

    it("FAILS OPEN when Redis errors (no 500, request allowed)", async () => {
      const { rateLimitAsync } = await loadModule();
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
      // Silence the expected error log.
      vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await rateLimitAsync({ key: "test:fail-open", limit: 1, windowSec: 60 });
      expect(res.ok).toBe(true);
    });

    it("FAILS OPEN on non-200 HTTP from Upstash", async () => {
      const { rateLimitAsync } = await loadModule();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("rate limited", { status: 429 })
      );
      vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await rateLimitAsync({ key: "test:http-err", limit: 1, windowSec: 60 });
      expect(res.ok).toBe(true);
    });
  });
});
