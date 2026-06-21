// probe-grpc-gasless.mjs
// Live, READ-ONLY verification of whether the gasless USDsui PTB can be
// built on the gRPC client instead of the JSON-RPC client.
//
// Mirrors web/scripts/probe-valid-during.mjs (public mainnet fullnode,
// same SENDER/RECIPIENT/USDSUI constants, toBase64, sui_dryRunTransactionBlock
// for dryRun, client.simulateTransaction for gRPC simulate).
//
// It does NOT execute any real transaction — build + dryRun + simulate ONLY.
//
// Cases (the PTB is always 0x2::balance::send_funds<USDSUI>(tx.balance, recipient)):
//   X) gRPC build, manual ValidDuring,  NO setGasPayment  (current prod approach via gRPC client)
//   Y) gRPC build, NO manual ValidDuring, NO setGasPayment (Mysten docs path: server auto-fills)
//   Z) gRPC build, manual ValidDuring,  WITH tx.setGasPayment([]) (offline build, skips simulate)
//   B) JSON-RPC build, manual ValidDuring (current prod baseline, for byte comparison)
//   U) Z-style build but dryRun/simulate an OVER-balance amount to capture the
//      validator's underfunded / withdraw-reservation / address-owned gRPC text.
//
// A FIXED nonce (1) is used across cases so the produced bytes are byte-comparable.
//
// Run:  cd web && node scripts/probe-grpc-gasless.mjs   (needs egress to fullnode.mainnet.sui.io)

import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { toBase64 } from "@mysten/sui/utils";

const USDSUI = "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const SENDER = "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c";
const RECIPIENT = "0x156a95a023b61177558de1de36409acf7f72417f9ca21a3a1e903e3b52283743";
const FULLNODE = "https://fullnode.mainnet.sui.io:443";

const FIXED_NONCE = 1; // fixed across cases for byte comparison
const AMOUNT = 100_000n; // 0.10 USDsui — SENDER can cover
const OVER_AMOUNT = 1_000_000_000_000_000n; // 10^15 micro — wildly over balance

const grpc = new SuiGrpcClient({ network: "mainnet", baseUrl: FULLNODE });
const jsonClient = new SuiJsonRpcClient({ network: "mainnet", url: FULLNODE });

function short(v, n = 320) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return (s ?? "").slice(0, n);
}

// ── Resolve chain identifier + current epoch the way the route does ──────────
let chainIdentifier;
let currentEpoch;
try {
  ({ chainIdentifier } = await grpc.core.getChainIdentifier());
  const sysR = await fetch(FULLNODE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "suix_getLatestSuiSystemState", params: [] }),
  });
  currentEpoch = BigInt((await sysR.json()).result.epoch);
} catch (e) {
  console.log(`SETUP-FATAL: could not reach mainnet fullnode: ${short(e.message ?? e)}`);
  console.log("VERDICT: ran_live=false (network egress to fullnode.mainnet.sui.io blocked)");
  process.exit(2);
}
console.log(`chainIdentifier=${chainIdentifier} currentEpoch=${currentEpoch}`);
console.log("");

function buildTx({ amount, withValidDuring, withEmptyGasPayment }) {
  const tx = new Transaction();
  tx.setSender(SENDER);
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [USDSUI],
    arguments: [
      tx.balance({ type: USDSUI, balance: BigInt(amount) }),
      tx.pure.address(RECIPIENT),
    ],
  });
  tx.setGasPrice(0n);
  tx.setGasBudget(0n);
  if (withValidDuring) {
    tx.setExpiration({
      ValidDuring: {
        minEpoch: String(currentEpoch),
        maxEpoch: String(currentEpoch + 1n),
        minTimestamp: null,
        maxTimestamp: null,
        chain: chainIdentifier,
        nonce: FIXED_NONCE,
      },
    });
  }
  if (withEmptyGasPayment) {
    // Empty-array payment flips needsTransactionResolution() to false
    // (resolve.mjs:11-12) so the resolver skips simulate → offline BCS build.
    tx.setGasPayment([]);
  }
  return tx;
}

async function dryRun(bytes) {
  const r = await fetch(FULLNODE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sui_dryRunTransactionBlock",
      params: [toBase64(bytes)],
    }),
  });
  const j = await r.json();
  if (j.error) return { ok: false, status: `RPC-ERROR ${short(j.error)}` };
  const status = j.result?.effects?.status;
  return { ok: status?.status === "success", status: short(status) };
}

async function grpcSimulate(bytes) {
  try {
    const sim = await grpc.simulateTransaction({ transaction: bytes, include: { effects: true } });
    const kind = sim.$kind;
    const status =
      sim?.Transaction?.effects?.status ??
      sim?.FailedTransaction?.effects?.status ??
      kind;
    return { ok: kind === "Transaction", status: short(status) };
  } catch (e) {
    return { ok: false, status: `SIM-ERR ${short(e.message ?? e)}`, errText: String(e.message ?? e) };
  }
}

const results = {}; // label -> { bytesB64, build_ok, dry, sim }

async function runCase(label, opts, { client, useJson }) {
  const tx = buildTx(opts);
  let bytes;
  try {
    bytes = await tx.build({ client: useJson ? jsonClient : grpc });
  } catch (e) {
    const errText = String(e.message ?? e);
    console.log(`[${label}] BUILD-ERR: ${short(errText)}`);
    results[label] = { build_ok: false, buildErr: errText };
    return;
  }
  const b64 = toBase64(bytes);
  const dry = await dryRun(bytes);
  const sim = await grpcSimulate(bytes);
  console.log(
    `[${label}] BUILD OK · bytes=${bytes.length}B · dryRun=${dry.ok ? "SUCCESS" : "FAIL"} (${dry.status}) · gRPC-sim=${sim.ok ? "SUCCESS" : "FAIL"} (${sim.status})`
  );
  results[label] = { build_ok: true, bytesB64: b64, byteLen: bytes.length, dry, sim };
}

// ── Cases ────────────────────────────────────────────────────────────────────
console.log("=== CASE X: gRPC build · manual ValidDuring · NO setGasPayment (current prod approach, gRPC client) ===");
await runCase("X", { amount: AMOUNT, withValidDuring: true, withEmptyGasPayment: false }, { useJson: false });

console.log("\n=== CASE Y: gRPC build · NO manual ValidDuring · NO setGasPayment (Mysten docs path) ===");
await runCase("Y", { amount: AMOUNT, withValidDuring: false, withEmptyGasPayment: false }, { useJson: false });

console.log("\n=== CASE Z: gRPC build · manual ValidDuring · WITH setGasPayment([]) (offline build, skips simulate) ===");
await runCase("Z", { amount: AMOUNT, withValidDuring: true, withEmptyGasPayment: true }, { useJson: false });

console.log("\n=== CASE B: JSON-RPC build · manual ValidDuring (current prod baseline) ===");
await runCase("B", { amount: AMOUNT, withValidDuring: true, withEmptyGasPayment: false }, { useJson: true });

// ── Byte comparison vs baseline B ──────────────────────────────────────────────
console.log("\n=== BYTE COMPARISON (fixed nonce) ===");
const B = results["B"];
function cmp(label) {
  const r = results[label];
  if (!r?.build_ok || !B?.build_ok) {
    console.log(`${label} vs B: na (one side did not build)`);
    return `na (${label} build_ok=${!!r?.build_ok}, B build_ok=${!!B?.build_ok})`;
  }
  const equal = r.bytesB64 === B.bytesB64;
  console.log(`${label} vs B: ${equal ? "EQUAL (byte-identical)" : "DIFFERENT"} (${label}=${r.byteLen}B, B=${B.byteLen}B)`);
  return equal ? "equal" : `diff (${label}=${r.byteLen}B vs B=${B.byteLen}B)`;
}
const cmpZ = cmp("Z");
const cmpX = cmp("X");

// ── Case U: capture gRPC error text for the underfunded / over-balance state ──
console.log("\n=== CASE U: Z-style build (setGasPayment([])) · over-balance amount → capture gRPC failure text ===");
const grpcErrorStrings = [];
{
  const tx = buildTx({ amount: OVER_AMOUNT, withValidDuring: true, withEmptyGasPayment: true });
  let bytes;
  try {
    bytes = await tx.build({ client: grpc });
    console.log(`[U] BUILD OK (offline, as expected — setGasPayment([]) skips simulate) · bytes=${bytes.length}B`);
    const dry = await dryRun(bytes);
    console.log(`[U] dryRun: ${dry.ok ? "SUCCESS" : "FAIL"} -> ${dry.status}`);
    if (!dry.ok) grpcErrorStrings.push(`[dryRun] ${dry.status}`);
    const sim = await grpcSimulate(bytes);
    console.log(`[U] gRPC-sim: ${sim.ok ? "SUCCESS" : "FAIL"} -> ${sim.status}`);
    if (!sim.ok) grpcErrorStrings.push(`[gRPC simulate] ${sim.errText ?? sim.status}`);
  } catch (e) {
    const errText = String(e.message ?? e);
    console.log(`[U] BUILD-ERR (over-balance surfaced at build time): ${short(errText)}`);
    grpcErrorStrings.push(`[gRPC build] ${errText}`);
  }
}

// Also capture the gRPC simulate text for the NO-gas-payment over-balance case
// (case X-style with over amount) — this is what fires today if resolution
// simulate still runs on gRPC.
console.log("\n=== CASE U2: X-style (NO setGasPayment) · over-balance · gRPC build (resolution simulate fires) ===");
{
  const tx = buildTx({ amount: OVER_AMOUNT, withValidDuring: true, withEmptyGasPayment: false });
  try {
    const bytes = await tx.build({ client: grpc });
    console.log(`[U2] BUILD OK (unexpected for over-balance if simulate fires) · bytes=${bytes.length}B`);
    const sim = await grpcSimulate(bytes);
    console.log(`[U2] gRPC-sim: ${sim.ok ? "SUCCESS" : "FAIL"} -> ${sim.status}`);
    if (!sim.ok) grpcErrorStrings.push(`[gRPC simulate via X-style] ${sim.errText ?? sim.status}`);
  } catch (e) {
    const errText = String(e.message ?? e);
    console.log(`[U2] BUILD-ERR (build-time resolution simulate rejected): ${short(errText)}`);
    grpcErrorStrings.push(`[gRPC build resolution-simulate] ${errText}`);
  }
}

// ── Summary block (machine-parseable) ─────────────────────────────────────────
console.log("\n=== SUMMARY ===");
for (const label of ["X", "Y", "Z", "B"]) {
  const r = results[label];
  if (!r) { console.log(`${label}: (not run)`); continue; }
  if (!r.build_ok) { console.log(`${label}: build_ok=false err=${short(r.buildErr, 200)}`); continue; }
  console.log(`${label}: build_ok=true dryRun=${r.dry.ok ? "SUCCESS" : "FAIL"} gRPCsim=${r.sim.ok ? "SUCCESS" : "FAIL"}`);
}
console.log(`byteCompare Z-vs-B: ${cmpZ}`);
console.log(`byteCompare X-vs-B: ${cmpX}`);
console.log("grpcErrorStrings:");
for (const s of grpcErrorStrings) console.log(`  - ${short(s, 400)}`);
console.log("RAN_LIVE: true");
