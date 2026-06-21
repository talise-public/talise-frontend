#!/usr/bin/env node
/**
 * zkLogin signing speed test for Talise.
 *
 * Mirrors the production signing pipeline laid out in `lib/zksigner.ts`:
 *   1. Ephemeral key generation       (Ed25519Keypair.generate)
 *   2. Prover round-trip               (Mysten / Shinami zk proof)
 *   3. Signature assembly              (getZkLoginSignature wrap)
 *   4. PTB build                       (no-op MoveCall tx kind bytes)
 *
 * Runs 10 independent iterations and prints min / p50 / p90 / p99 / max /
 * mean / stddev per leg.
 *
 * JWT handling:
 *   - If `ZK_TEST_JWT` is set in env, the prover round-trip runs for real.
 *   - Otherwise the prover leg is SKIPPED with an explanatory note, and only
 *     the local-only legs (keygen, address derive, PTB build, sig assembly
 *     with a dummy proof) are measured. We never hardcode a JWT.
 *
 * Run with:
 *
 *   cd web && node scripts/zk-speed-test.mjs
 *
 * (Optionally `node --env-file=.env.local scripts/zk-speed-test.mjs` if you
 * want SHINAMI_API_KEY / ZK_PROVER_URL picked up from your local env file.)
 */

import { performance } from "node:perf_hooks";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import {
  generateNonce,
  generateRandomness,
  getExtendedEphemeralPublicKey,
  genAddressSeed,
  getZkLoginSignature,
} from "@mysten/sui/zklogin";

// ---- config -----------------------------------------------------------------

const ITERATIONS = 10;

const NETWORK = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? "mainnet").toLowerCase();

// CLI args: --prover-url=<https…> [--mode=mysten|shinami|gpu]
// `--mode` is a label only — the wire format is identical to Mysten's. Use
// `--mode=shinami` to drive the JSON-RPC envelope, otherwise we hit the
// plain `/input`-style POST that Mysten + unconfirmedlabs GPU both speak.
const CLI = (() => {
  const args = process.argv.slice(2);
  const out = { proverUrl: null, mode: null };
  for (const a of args) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "prover-url") out.proverUrl = (v ?? "").trim() || null;
    if (k === "mode") out.mode = (v ?? "").trim() || null;
  }
  return out;
})();

const PROVER_URL = (() => {
  const cli = CLI.proverUrl;
  if (cli) return cli.replace(/\/+$/, "");
  const override = process.env.ZK_PROVER_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  return NETWORK === "testnet"
    ? "https://prover-dev.mystenlabs.com/v1"
    : "https://prover.mystenlabs.com/v1";
})();

const SHINAMI_KEY = process.env.SHINAMI_API_KEY?.trim();
const SHINAMI_PROVER_URL = "https://api.us1.shinami.com/sui/zkprover/v1";

// `--mode` overrides auto-detect: lets us benchmark Shinami specifically even
// when ZK_PROVER_URL is set, or force GPU/Mysten flow when SHINAMI_API_KEY is
// also present (Shinami would otherwise win the auto-detect).
const MODE_OVERRIDE = CLI.mode; // null | "mysten" | "shinami" | "gpu"

const TEST_JWT = process.env.ZK_TEST_JWT?.trim();
// Salt must be a decimal-string BigInt. Use a deterministic stand-in unless
// the caller supplies one to match their Shinami-managed salt.
const TEST_SALT = process.env.ZK_TEST_SALT?.trim() ?? "129390038138493874623423423423";

const SPONSOR_URL = process.env.ZK_TEST_SPONSOR_URL?.trim();

// ---- stats helpers ----------------------------------------------------------

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarise(samples) {
  if (samples.length === 0) {
    return { n: 0, min: NaN, p50: NaN, p90: NaN, p99: NaN, max: NaN, mean: NaN, stddev: NaN };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  const mean = sum / samples.length;
  const variance = samples.reduce((acc, v) => acc + (v - mean) ** 2, 0) / samples.length;
  return {
    n: samples.length,
    min: sorted[0],
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1],
    mean,
    stddev: Math.sqrt(variance),
  };
}

function fmt(ms) {
  if (Number.isNaN(ms)) return "   n/a";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 10) return `${ms.toFixed(1)}ms`;
  return `${ms.toFixed(2)}ms`;
}

function printTable(rows) {
  const headers = ["leg", "n", "min", "p50", "p90", "p99", "max", "mean", "stddev"];
  const colW = headers.map((h) => h.length);
  const lines = [headers];
  for (const r of rows) {
    const cells = [
      r.name,
      String(r.s.n),
      fmt(r.s.min),
      fmt(r.s.p50),
      fmt(r.s.p90),
      fmt(r.s.p99),
      fmt(r.s.max),
      fmt(r.s.mean),
      fmt(r.s.stddev),
    ];
    cells.forEach((c, i) => {
      if (c.length > colW[i]) colW[i] = c.length;
    });
    lines.push(cells);
  }
  const sep = "  ";
  for (const line of lines) {
    console.log(line.map((c, i) => c.padEnd(colW[i])).join(sep));
  }
}

// ---- dummy proof for local-only signature assembly --------------------------

// A structurally-valid Groth16-shaped proof. Values are zeros — the wrapped
// signature is NOT cryptographically valid; we only use it to measure the
// LOCAL CPU work of getZkLoginSignature() (BCS encoding + base64).
function dummyProofInputs(addressSeed) {
  return {
    proofPoints: {
      a: ["0", "0", "1"],
      b: [["0", "0"], ["0", "0"], ["1", "0"]],
      c: ["0", "0", "1"],
    },
    issBase64Details: { value: "yJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20i", indexMod4: 1 },
    headerBase64: "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3QiLCJ0eXAiOiJKV1QifQ",
    addressSeed,
  };
}

// ---- prover callers (match lib/zksigner.ts + lib/shinami.ts) -----------------

async function callMystenProver(inputs) {
  const r = await fetch(PROVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(inputs),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`mysten prover ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function callShinamiProver(opts) {
  const r = await fetch(SHINAMI_PROVER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": SHINAMI_KEY,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "shinami_zkp_createZkLoginProof",
      params: [
        opts.jwt,
        String(opts.maxEpoch),
        opts.extendedEphemeralPublicKey,
        opts.jwtRandomness,
        opts.salt,
        "sub",
      ],
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`shinami prover ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  if (j.error) throw new Error(`shinami rpc: ${j.error.message}`);
  return j.result.zkProof;
}

function decodeJwtClaims(jwt) {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("malformed JWT");
  const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
  const json = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json);
}

// ---- one iteration ----------------------------------------------------------

async function fetchEpoch() {
  const client = new SuiJsonRpcClient({
    url: getJsonRpcFullnodeUrl(NETWORK === "testnet" ? "testnet" : "mainnet"),
    network: NETWORK === "testnet" ? "testnet" : "mainnet",
  });
  const sys = await client.getLatestSuiSystemState();
  return Number(sys.epoch);
}

async function runIteration(ctx) {
  const r = {};

  // ---- (1) keygen ----------------------------------------------------------
  {
    const t = performance.now();
    const eph = Ed25519Keypair.generate();
    const pubKey = eph.getPublicKey();
    const randomness = generateRandomness();
    const maxEpoch = ctx.epoch + 10;
    const nonce = generateNonce(pubKey, maxEpoch, randomness);
    r.keygen = performance.now() - t;
    r._eph = eph;
    r._pubKey = pubKey;
    r._randomness = randomness;
    r._maxEpoch = maxEpoch;
    r._nonce = nonce;
  }

  // ---- (2) PTB build (no-op MoveCall, sponsor-policy compatible) -----------
  let txBytes;
  {
    const t = performance.now();
    const tx = new Transaction();
    // Deterministic sender so tx.build doesn't refuse — we use a stable
    // synthetic address; we are not submitting, just measuring serialization.
    tx.setSender("0x000000000000000000000000000000000000000000000000000000000000abcd");
    tx.setGasPrice(1000n);
    tx.setGasBudget(10_000_000n);
    tx.setGasPayment([
      {
        // dummy gas coin reference; only used for build serialization, not chain
        objectId: "0x000000000000000000000000000000000000000000000000000000000000beef",
        version: "1",
        digest: "11111111111111111111111111111111",
      },
    ]);
    tx.moveCall({ target: "0x1::option::none", typeArguments: ["address"] });
    txBytes = await tx.build({ onlyTransactionKind: false });
    r.ptbBuild = performance.now() - t;
    r._txBytes = txBytes;
  }

  // ---- (3) prover round-trip ----------------------------------------------
  let proof = null;
  if (ctx.proverMode !== "skip") {
    const extendedEphemeralPublicKey = getExtendedEphemeralPublicKey(r._pubKey);
    const t = performance.now();
    try {
      if (ctx.proverMode === "shinami") {
        proof = await callShinamiProver({
          jwt: ctx.jwt,
          maxEpoch: r._maxEpoch,
          extendedEphemeralPublicKey,
          jwtRandomness: r._randomness,
          salt: ctx.salt,
        });
      } else {
        proof = await callMystenProver({
          jwt: ctx.jwt,
          extendedEphemeralPublicKey,
          maxEpoch: r._maxEpoch,
          jwtRandomness: r._randomness,
          salt: ctx.salt,
          keyClaimName: "sub",
        });
      }
      r.prover = performance.now() - t;
    } catch (err) {
      r.proverErr = String(err.message ?? err);
      r.prover = NaN;
    }
  }

  // ---- (4) signature assembly ---------------------------------------------
  {
    // Use real proof if we have one, else the structural dummy. Either way
    // we measure the local CPU cost of wrapping.
    let addressSeed = "0";
    if (ctx.jwt) {
      try {
        const claims = decodeJwtClaims(ctx.jwt);
        addressSeed = genAddressSeed(BigInt(ctx.salt), "sub", claims.sub, claims.aud).toString();
      } catch {
        // fall through with addressSeed=0
      }
    }
    const inputs = proof
      ? { ...proof, addressSeed }
      : dummyProofInputs(addressSeed);

    const { signature: userSig } = await r._eph.signTransaction(r._txBytes);

    const t = performance.now();
    const sig = getZkLoginSignature({
      inputs,
      maxEpoch: r._maxEpoch,
      userSignature: userSig,
    });
    r.assemble = performance.now() - t;
    r._sig = sig;
  }

  // ---- (5) optional sponsor end-to-end ------------------------------------
  if (ctx.sponsorUrl && proof) {
    const t = performance.now();
    try {
      const sr = await fetch(ctx.sponsorUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bytesB64: toBase64(r._txBytes),
          ephemeralPubKeyB64: toBase64(r._pubKey.toRawBytes()),
          maxEpoch: r._maxEpoch,
          randomness: r._randomness,
          userSignature: r._sig,
        }),
      });
      await sr.text();
      r.sponsor = performance.now() - t;
    } catch (err) {
      r.sponsorErr = String(err.message ?? err);
      r.sponsor = NaN;
    }
  }

  return r;
}

// ---- main -------------------------------------------------------------------

async function main() {
  const havePr = !!TEST_JWT;
  let proverMode;
  if (!havePr) {
    proverMode = "skip";
  } else if (MODE_OVERRIDE) {
    // `gpu` and `mysten` both speak the plain POST envelope.
    proverMode = MODE_OVERRIDE === "shinami" ? "shinami" : "mysten";
  } else {
    proverMode = SHINAMI_KEY ? "shinami" : "mysten";
  }
  const proverLabel = MODE_OVERRIDE ?? proverMode;

  console.log("=".repeat(72));
  console.log("Talise zkLogin signing speed test");
  console.log("=".repeat(72));
  console.log(`network        : ${NETWORK}`);
  console.log(`iterations     : ${ITERATIONS}`);
  console.log(`prover mode    : ${proverLabel}${MODE_OVERRIDE ? "  (cli-forced)" : ""}`);
  if (proverMode === "mysten") console.log(`  prover URL   : ${PROVER_URL}`);
  if (proverMode === "shinami") console.log(`  prover URL   : ${SHINAMI_PROVER_URL}`);
  console.log(`sponsor URL    : ${SPONSOR_URL ?? "(not configured — end-to-end skipped)"}`);
  console.log("");
  if (proverMode === "skip") {
    console.log(
      "NOTE: ZK_TEST_JWT not set. Prover round-trip will be SKIPPED.\n" +
      "      Only local legs (keygen, PTB build, signature assembly with a\n" +
      "      structural dummy proof) will be measured. To time the prover too,\n" +
      "      paste a fresh Google JWT into ZK_TEST_JWT in your env and re-run.\n" +
      "      No JWT is ever hardcoded."
    );
    console.log("");
  }

  // Fetch the current epoch once so each iteration starts from a fresh
  // ephemeral key but reuses the same maxEpoch baseline. If RPC fails, we
  // fall back to a sensible default — keygen-only timing doesn't need it.
  let epoch = 0;
  try {
    epoch = await fetchEpoch();
    console.log(`current epoch  : ${epoch}`);
  } catch (err) {
    console.log(`current epoch  : (fetch failed — ${err.message}; defaulting to 0)`);
  }
  console.log("");

  const ctx = {
    proverMode,
    jwt: TEST_JWT,
    salt: TEST_SALT,
    sponsorUrl: SPONSOR_URL,
    epoch,
  };

  const series = {
    keygen: [],
    ptbBuild: [],
    prover: [],
    assemble: [],
    sponsor: [],
  };
  const errors = { prover: 0, sponsor: 0 };

  for (let i = 0; i < ITERATIONS; i++) {
    process.stdout.write(`  iter ${String(i + 1).padStart(2)}/${ITERATIONS} ... `);
    let row;
    try {
      row = await runIteration(ctx);
    } catch (err) {
      console.log(`FAILED (${err.message})`);
      continue;
    }
    series.keygen.push(row.keygen);
    series.ptbBuild.push(row.ptbBuild);
    if (Number.isFinite(row.prover)) series.prover.push(row.prover);
    else if (row.proverErr) errors.prover++;
    series.assemble.push(row.assemble);
    if (Number.isFinite(row.sponsor)) series.sponsor.push(row.sponsor);
    else if (row.sponsorErr) errors.sponsor++;

    const parts = [
      `keygen=${fmt(row.keygen)}`,
      `ptb=${fmt(row.ptbBuild)}`,
      row.prover != null ? `prover=${row.proverErr ? "ERR" : fmt(row.prover)}` : null,
      `asm=${fmt(row.assemble)}`,
      row.sponsor != null ? `sponsor=${row.sponsorErr ? "ERR" : fmt(row.sponsor)}` : null,
    ].filter(Boolean);
    console.log(parts.join("  "));
    if (row.proverErr) console.log(`             prover error: ${row.proverErr}`);
  }

  console.log("");
  console.log("Results (lower is better)");
  console.log("-".repeat(72));

  const rows = [
    { name: "keygen+nonce", s: summarise(series.keygen) },
    { name: "ptb build",    s: summarise(series.ptbBuild) },
    { name: "prover RT",    s: summarise(series.prover) },
    { name: "sig assemble", s: summarise(series.assemble) },
    { name: "sponsor RT",   s: summarise(series.sponsor) },
  ];
  printTable(rows);

  // Runnable-legs accounting --------------------------------------------------
  const runnable = [
    series.keygen.length > 0 ? "keygen" : null,
    series.ptbBuild.length > 0 ? "ptb" : null,
    series.prover.length > 0 ? "prover" : null,
    series.assemble.length > 0 ? "assemble" : null,
  ].filter(Boolean);
  const total = 4;
  console.log("");
  console.log(`legs runnable: ${runnable.length} of ${total}  (${runnable.join(", ") || "none"})`);
  if (errors.prover > 0) console.log(`prover errors: ${errors.prover}`);
  if (errors.sponsor > 0) console.log(`sponsor errors: ${errors.sponsor}`);

  // Quick total estimate ------------------------------------------------------
  const meanOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const meanTotal =
    meanOf(series.keygen) +
    meanOf(series.ptbBuild) +
    meanOf(series.prover) +
    meanOf(series.assemble);
  console.log("");
  console.log(`estimated mean end-to-end (local + prover): ${fmt(meanTotal)}`);
}

main().catch((err) => {
  console.error("zk-speed-test crashed:", err);
  process.exit(1);
});
