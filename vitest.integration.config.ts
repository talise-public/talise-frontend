import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest config for SLOW, network-dependent integration tests against Sui
 * mainnet. Not part of the default test run — invoke via the `test:integration`
 * package script.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Stub Next.js `server-only` so server-bound libs (e.g.
      // `lib/activity.ts`) can be imported under Vitest without the
      // "Cannot find package 'server-only'" runtime error. The marker
      // package has no runtime code in production either — it just
      // throws at build time if pulled into a client module.
      "server-only": path.resolve(__dirname, "__tests__/sui/server-only-stub.ts"),
      // Mirror the `tsconfig.json` `@/*` path alias so server-only
      // libs that import via `@/lib/...` resolve inside Vitest.
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    include: ["__tests__/sui/**/*.test.ts"],
    setupFiles: ["__tests__/sui/_setup.integration.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // These tests hit real Sui mainnet RPC, which occasionally drifts,
    // rate-limits, or disconnects mid-run (e.g. a transient "tx fetch failed"
    // instead of the expected verification result). Retry a couple of times so
    // a flaky upstream blip doesn't red the build; a real regression still
    // fails all attempts.
    retry: 2,
    // Mainnet rate-limits aggressive parallelism; one test file at a time is
    // enough today, so we don't need explicit pool/forks config — Vitest's
    // default is fine. If we add more test files and start hitting limits,
    // re-introduce poolOptions then with whatever the typed shape is at that
    // Vitest version.
    pool: "forks",
  },
});
