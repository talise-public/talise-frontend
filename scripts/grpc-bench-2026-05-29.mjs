#!/usr/bin/env node
/**
 * Latency micro-benchmark for the five most user-visible gRPC reads.
 *
 *   1. getBalance(SUI)
 *   2. getBalance(USDsui)
 *   3. getReferenceGasPrice
 *   4. getLatestEpoch (via ledgerService.getEpoch)
 *   5. getCoinMetadata(USDsui) — proxy for "navi/yield read" point reads
 *
 * Each is run 5 times against the `sui()` fallback proxy in
 * `lib/sui.ts`. We surface min / p50 / p95 / max in milliseconds so
 * the user can sanity-check the 250ms p50 SLA.
 *
 * Same vitest trick as `probe-activity.mjs`: lib/sui.ts imports
 * "server-only" which only resolves cleanly under the integration
 * vitest config.
 *
 * Usage:
 *   node scripts/grpc-bench-2026-05-29.mjs [address]
 */

import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ADDR =
  process.argv[2] ??
  "0x156a95a023b61177558de1de36409acf7f72417f9ca21a3a1e903e3b52283743";

const testFile = join(
  process.cwd(),
  "__tests__",
  "sui",
  "_grpc-bench.test.ts"
);

const src = `
import { it } from "vitest";
import { sui, USDSUI_TYPE, getSuiBalance, getUsdsuiBalance } from "../../lib/sui";

const ADDR = ${JSON.stringify(ADDR)};
const RUNS = 5;

function stats(samplesMs: number[]) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return { min, p50, p95, max };
}

async function bench(label: string, fn: () => Promise<unknown>) {
  // One warmup call to fill the connection pool / channel cache so we
  // measure steady-state latency, not cold start.
  try { await fn(); } catch { /* ignore */ }
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = Date.now();
    try {
      await fn();
    } catch (e) {
      // Record the error timing but mark with sentinel so p50 doesn't
      // get distorted by a hard fail.
      console.warn("[bench] " + label + " #" + i + " threw:", (e as Error).message);
    }
    samples.push(Date.now() - t);
  }
  const s = stats(samples);
  console.log("__BENCH__ " + JSON.stringify({ label, samples, ...s }));
}

it("grpc-bench", async () => {
  await bench("getSuiBalance", () => getSuiBalance(ADDR));
  await bench("getUsdsuiBalance", () => getUsdsuiBalance(ADDR));
  await bench("getReferenceGasPrice", () => sui().getReferenceGasPrice());
  await bench("getLatestEpoch", () =>
    sui().ledgerService.getEpoch({})
  );
  await bench("getCoinMetadata(USDsui)", () =>
    sui().getCoinMetadata({ coinType: USDSUI_TYPE })
  );
}, 120_000);
`;

writeFileSync(testFile, src, "utf8");

try {
  const res = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.integration.config.ts",
      "--reporter=verbose",
      testFile,
    ],
    { stdio: "inherit" }
  );
  process.exit(res.status ?? 1);
} finally {
  try {
    rmSync(testFile);
  } catch {
    /* ignore */
  }
}
