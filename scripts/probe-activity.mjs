#!/usr/bin/env node
/**
 * One-shot probe for `getRecentActivity()` after the GraphQL schema
 * migration. Runs the integration harness (vitest) against the live
 * `lib/activity.ts` and dumps the first few entries returned for a
 * known-active mainnet address so the post-migration adapter can be
 * eyeballed manually.
 *
 * Why vitest: `lib/activity.ts` imports `"server-only"` (Next-runtime
 * marker package, not installed as a node_modules entry). The
 * integration vitest config aliases it to a no-op stub, which is the
 * cleanest way to load the server-bound module under a plain Node
 * runtime. The script just wraps `vitest run` with the existing
 * config + a transient test file that prints what we want.
 *
 * Usage:
 *   node scripts/probe-activity.mjs [address] [limit]
 */

import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const ADDR =
  process.argv[2] ??
  // Backup from __tests__/sui/activity.test.ts — Mysten-affiliated
  // address with recent on-chain flow.
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29";
const LIMIT = Number(process.argv[3] ?? 5);

// Drop a transient test file inside __tests__/sui so the existing
// vitest.integration.config.ts picks it up (its `include` glob covers
// that directory). Delete on exit.
const testFile = join(
  process.cwd(),
  "__tests__",
  "sui",
  "_probe-activity.test.ts"
);
const src = `
import { it } from "vitest";
import { getRecentActivity } from "../../lib/activity";

it("probe", async () => {
  const entries = await getRecentActivity(${JSON.stringify(ADDR)}, ${LIMIT}, {
    includeNonTalise: true,
    vaultId: null,
  });
  console.log("__PROBE_RESULT__", JSON.stringify({
    addr: ${JSON.stringify(ADDR)},
    limit: ${LIMIT},
    count: entries.length,
    entries,
  }, null, 2));
}, 60_000);
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
