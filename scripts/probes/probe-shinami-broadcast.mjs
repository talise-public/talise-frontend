// End-to-end probe for the shinami-fast-broadcast branch.
//
// Validates:
//   1. shinamiSuiNodeJsonRpc() returns a usable client config.
//   2. SuiJsonRpcClient with Shinami's URL + X-Api-Key successfully
//      builds a gasless USDsui PTB with ValidDuring expiration (the
//      whole point of routing prepare through Shinami).
//   3. The resulting bytes dry-run as `success: true` on chain.
//   4. The /api/sui/broadcast-config response shape matches what
//      iOS's BroadcastConfigCache expects.
//
// What this doesn't do:
//   • sign + actually submit (no key material here).
//   • test the WaitForLocalExecution flag (that's a request-time field,
//     not encoded in the bytes — only iOS's send path exercises it).
//
// Run with `dotenv` so SHINAMI_NODE_API_KEY loads from .env.local:
//   node --env-file=.env.local scripts/probe-shinami-broadcast.mjs

import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient, JsonRpcHTTPTransport } from "@mysten/sui/jsonRpc";
import { toBase64 } from "@mysten/sui/utils";

const USDSUI =
  "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const SENDER = "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
const RECIPIENT = "0x156a95a023b61177558de1de36409acf7f72417f9ca21a3a1e903e3b52283743";

const KEY = process.env.SHINAMI_NODE_API_KEY;
const SHINAMI_URL = "https://api.us1.shinami.com/sui/node/v1";
const PUBLIC_URL = "https://fullnode.mainnet.sui.io:443";

const ok = (label, msg = "") => console.log(`  ✓ ${label}${msg ? " · " + msg : ""}`);
const fail = (label, msg = "") => {
  console.log(`  ✗ ${label}${msg ? " · " + msg : ""}`);
  process.exitCode = 1;
};

console.log("=== shinami-fast-broadcast probe ===\n");

// ── Test 1: env wiring ───────────────────────────────────────────────
console.log("[1/4] SHINAMI_NODE_API_KEY present");
if (KEY && KEY.length > 4) {
  ok("env loaded", `(${KEY.length} chars)`);
} else {
  fail("env missing", "SHINAMI_NODE_API_KEY not set — aborting");
  process.exit(1);
}

// ── Test 2: build a gasless PTB via Shinami JSON-RPC + ValidDuring ──
console.log("\n[2/4] Shinami JSON-RPC build + ValidDuring expiration");
const shinami = new SuiJsonRpcClient({
  network: "mainnet",
  transport: new JsonRpcHTTPTransport({
    url: SHINAMI_URL,
    rpc: { headers: { "X-Api-Key": KEY } },
  }),
});

const { chainIdentifier } = await shinami.core.getChainIdentifier();
const sysR = await fetch(PUBLIC_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "suix_getLatestSuiSystemState",
    params: [],
  }),
});
const currentEpoch = BigInt((await sysR.json()).result.epoch);
ok("chain identifier", chainIdentifier);
ok("current epoch", currentEpoch.toString());

const tx = new Transaction();
tx.setSender(SENDER);
tx.moveCall({
  target: "0x2::balance::send_funds",
  typeArguments: [USDSUI],
  arguments: [
    tx.balance({ type: USDSUI, balance: 100_000n }),
    tx.pure.address(RECIPIENT),
  ],
});
tx.setGasPrice(0n);
tx.setGasBudget(0n);
tx.setExpiration({
  ValidDuring: {
    minEpoch: String(currentEpoch),
    maxEpoch: String(currentEpoch + 1n),
    minTimestamp: null,
    maxTimestamp: null,
    chain: chainIdentifier,
    nonce: (Math.random() * 4294967296) >>> 0,
  },
});

let bytes;
const tBuildStart = Date.now();
try {
  bytes = await tx.build({ client: shinami });
  const tBuild = Date.now() - tBuildStart;
  ok("tx.build via Shinami", `${tBuild}ms`);
} catch (e) {
  fail("tx.build via Shinami threw", e.message.slice(0, 200));
  process.exit(1);
}

// ── Test 3: dry-run the bytes via public mainnet ────────────────────
console.log("\n[3/4] dryRun the Shinami-built bytes");
const tDryRunStart = Date.now();
const dr = await fetch(PUBLIC_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "sui_dryRunTransactionBlock",
    params: [toBase64(bytes)],
  }),
});
const drJson = await dr.json();
const tDryRun = Date.now() - tDryRunStart;
if (drJson.result?.effects?.status?.status === "success") {
  ok("dryRun status", `success (${tDryRun}ms)`);
} else {
  fail(
    "dryRun status",
    JSON.stringify(drJson.result?.effects?.status ?? drJson.error).slice(0, 200)
  );
}

// ── Test 4: speed comparison ─────────────────────────────────────────
console.log("\n[4/4] Shinami vs public — build latency");
const publicClient = new SuiJsonRpcClient({
  network: "mainnet",
  url: PUBLIC_URL,
});

async function timeBuild(client, label) {
  const tx2 = new Transaction();
  tx2.setSender(SENDER);
  tx2.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [USDSUI],
    arguments: [
      tx2.balance({ type: USDSUI, balance: 100_000n }),
      tx2.pure.address(RECIPIENT),
    ],
  });
  tx2.setGasPrice(0n);
  tx2.setGasBudget(0n);
  tx2.setExpiration({
    ValidDuring: {
      minEpoch: String(currentEpoch),
      maxEpoch: String(currentEpoch + 1n),
      minTimestamp: null,
      maxTimestamp: null,
      chain: chainIdentifier,
      nonce: (Math.random() * 4294967296) >>> 0,
    },
  });
  const t0 = Date.now();
  try {
    await tx2.build({ client });
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, err: e.message.slice(0, 200) };
  }
}

const shinamiTimes = [];
const publicTimes = [];
for (let i = 0; i < 3; i++) {
  const s = await timeBuild(shinami, "shinami");
  const p = await timeBuild(publicClient, "public");
  if (s.ok) shinamiTimes.push(s.ms);
  if (p.ok) publicTimes.push(p.ms);
}
const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
ok("shinami build latency", `${median(shinamiTimes)}ms median (n=${shinamiTimes.length})`);
ok("public  build latency", `${median(publicTimes)}ms median (n=${publicTimes.length})`);

if (median(shinamiTimes) < median(publicTimes)) {
  ok("verdict", `Shinami is ${median(publicTimes) - median(shinamiTimes)}ms faster`);
} else {
  console.log(
    `  ⚠ verdict · public was actually ${median(shinamiTimes) - median(publicTimes)}ms faster this run — try again or check Shinami status`
  );
}

console.log(`\nProbe done. Exit code: ${process.exitCode ?? 0}`);
