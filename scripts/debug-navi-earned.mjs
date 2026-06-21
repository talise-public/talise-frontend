#!/usr/bin/env node
/**
 * debug-navi-earned.mjs
 *
 * Investigate why the Navi WithdrawSheet "Earned so far" field reads 0
 * when the user has been supplied for hours.
 *
 * Walks the same path as `/api/yield/comparison`:
 *   1) Replays the user's on-chain activity, isolating Navi supplies/withdraws.
 *      Inlines the relevant pieces of `lib/activity.ts` and
 *      `lib/intents/wrap-payment-kit.ts` so we don't need to load the
 *      Next.js / server-only modules from a plain Node script.
 *   2) Calls `NaviAdapter.getPositions()` for the live USDsui supply
 *      balance (current redeemable value — includes accrued interest).
 *   3) Prints the math: principal vs current vs earned.
 *
 * Run:
 *   cd web && node scripts/debug-navi-earned.mjs <address?>
 *
 * Falls back to a synthetic test if the on-chain replay yields no
 * useful data (e.g. when this script runs outside the deployment
 * environment and can't see the user's history). The synthetic case
 * still exercises the math we ship.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
import { PaymentKitClient } from "@mysten/payment-kit";
import { NaviAdapter } from "@t2000/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..");

// Minimal local .env loader so we don't add a `dotenv` dep. Reads
// `.env.local` then `.env`, parses `KEY=VALUE` lines (ignoring blanks,
// comments, and quotes). Falls through silently if a file is missing.
function loadEnv(p) {
  try {
    const txt = fs.readFileSync(p, "utf8");
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {
    /* file absent / unreadable — fine */
  }
}
loadEnv(path.join(WEB_ROOT, ".env.local"));
loadEnv(path.join(WEB_ROOT, ".env"));

const USDSUI_TYPE =
  "0x8b8b6f33619e3a3a4f8e83d2c2c7d3d8ca8eb7c3d6b3aacbf48ec0a08e3a1e1c::usdsui::USDSUI"; // overridden below if env present
// We read USDsui type indirectly — the activity classifier only needs
// the on-chain hex constant. For correctness, mirror what lib/usdsui.ts
// resolves. The simplest path: also accept any coinType whose `::` last
// segment is "USDSUI" (case-insensitive) — that's what our `isUsdsui`
// check effectively does. Implemented in `isUsdsuiCoinType` below.

const TARGET_ADDR =
  (process.argv[2] || "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c").toLowerCase();

const NETWORK = (process.env.NEXT_PUBLIC_SUI_NETWORK || "mainnet").toLowerCase();
const MAINNET_NAMESPACE_ID =
  "0xccd3e4c7802921991cd9ce488c4ca0b51334ba75483702744242284ccf3ae7c2";
const TESTNET_NAMESPACE_ID =
  "0xa5016862fdccba7cc576b56cc5a391eda6775200aaa03a6b3c97d512312878db";

// ---------------------------------------------------------------------------
// Inline copies of lib/intents/wrap-payment-kit.ts parser bits.
// ---------------------------------------------------------------------------
const SCHEMA_PREFIX = "t1";
const KIND_CODE = {
  send: "s", invest: "i", withdraw: "w", swap: "p",
  recur: "r", split: "x", agent_pay: "a",
};
const KIND_FROM_CODE = Object.fromEntries(
  Object.entries(KIND_CODE).map(([k, v]) => [v, k])
);
const VENUE_CODE = { navi: "n", deepbook: "d" };
const VENUE_FROM_CODE = Object.fromEntries(
  Object.entries(VENUE_CODE).map(([k, v]) => [v, k])
);

function parsePaymentKitNonce(nonce) {
  if (!nonce || !nonce.startsWith(SCHEMA_PREFIX) || nonce.length < 27) return null;
  const kindCh = nonce[2];
  const kind = KIND_FROM_CODE[kindCh];
  if (!kind) return null;
  const ts36 = nonce.slice(3, 11);
  const timestampMs = parseInt(ts36, 36);
  if (!Number.isFinite(timestampMs)) return null;
  const refSlot = nonce.slice(27);
  const refs = {};
  if (refSlot.length > 0) {
    const venue = VENUE_FROM_CODE[refSlot[0]];
    if (venue) refs.venue = venue;
  }
  return { kind, refs, timestampMs };
}

function isUsdsuiCoinType(coinType) {
  if (!coinType) return false;
  const lower = coinType.toLowerCase();
  return /::usdsui::usdsui$/.test(lower);
}

function readPureString(input) {
  if (!input || input.type !== "pure") return null;
  if (typeof input.value === "string") return input.value;
  if (Array.isArray(input.value)) {
    try { return Buffer.from(input.value).toString("utf8"); } catch { return null; }
  }
  return null;
}

function readU64AsUsdsui(input) {
  if (!input || input.type !== "pure") return 0;
  const v = input.value;
  let micro = 0;
  if (typeof v === "string") {
    const n = Number(v);
    micro = Number.isFinite(n) ? n : 0;
  } else if (typeof v === "number") {
    micro = v;
  }
  return micro / 1e6;
}

// VENUE_PACKAGES mirrored from lib/activity.ts so we can detect navi
// supplies even when no PK PaymentRecord exists (e.g. heuristic path B).
const VENUE_PACKAGES = [
  { pkg: "0x97d9473771b01f77b0940c589484184b49f6444627ec121314fae6a6d36fb86b", venue: "deepbook" },
  { pkg: "0xfbd322126f1452fd4c89aedbaeb9fd0c44df9b5cedbe70d76bf80dc086031377", venue: "deepbook" },
  { pkg: "0x124bb3d8105d6d301c0d40feaa54d65df6b301e4d8ddd5eb8475b0f8a18cff2e", venue: "deepbook" },
  { pkg: "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb", venue: "navi" },
];
const WITHDRAW_FN_HINTS = ["withdraw", "redeem", "claim"];

function classifyVenueRaw(tx) {
  const moveTxs = tx.transaction?.data?.transaction?.transactions ?? [];
  for (const t of moveTxs) {
    const call = t.MoveCall ?? t;
    const pkg = (call?.package ?? "").toLowerCase();
    const fn = (call?.function ?? "").toLowerCase();
    if (!pkg) continue;
    const hit = VENUE_PACKAGES.find((v) => v.pkg.toLowerCase() === pkg);
    if (!hit) continue;
    const isWithdraw = WITHDRAW_FN_HINTS.some((h) => fn.includes(h));
    return { venue: hit.venue, kind: isWithdraw ? "withdraw" : "invest" };
  }
  return null;
}

function parseAllPaymentRecords(tx, registryId) {
  const reg = (registryId || "").toLowerCase();
  let hasTalisePaymentRecord = false;
  for (const oc of tx.objectChanges ?? []) {
    const owner = oc.owner;
    if (!owner || typeof owner === "string") continue;
    const objOwner = owner.ObjectOwner;
    if (!objOwner || objOwner.toLowerCase() !== reg) continue;
    if (oc.objectType && /::payment_kit::PaymentRecord</.test(oc.objectType)) {
      hasTalisePaymentRecord = true;
      break;
    }
  }
  if (!hasTalisePaymentRecord) return [];
  const inputs = tx.transaction?.data?.transaction?.inputs ?? [];
  const moveTxs = tx.transaction?.data?.transaction?.transactions ?? [];
  const out = [];
  for (const t of moveTxs) {
    const call = t.MoveCall;
    if (!call) continue;
    if (call.module !== "payment_kit") continue;
    if (call.function !== "process_registry_payment") continue;
    const args = call.arguments ?? [];
    const nonceArg = args[1];
    const amountArg = args[2];
    if (!nonceArg || typeof nonceArg === "string") continue;
    const nonceIdx = nonceArg.Input;
    if (typeof nonceIdx !== "number") continue;
    const nonce = readPureString(inputs[nonceIdx]);
    if (!nonce) continue;
    const parsed = parsePaymentKitNonce(nonce);
    if (!parsed) continue;
    let amountUsdsui = 0;
    if (amountArg && typeof amountArg !== "string") {
      const amountIdx = amountArg.Input;
      if (typeof amountIdx === "number") amountUsdsui = readU64AsUsdsui(inputs[amountIdx]);
    }
    out.push({ ...parsed, amountUsdsui });
  }
  return out;
}

function summarizeUserUsdsuiDelta(tx, address) {
  const me = address.toLowerCase();
  let myUsdsui = 0;
  for (const b of tx.balanceChanges ?? []) {
    if (!b.coinType || !isUsdsuiCoinType(b.coinType)) continue;
    let owner = null;
    if (b.owner && typeof b.owner !== "string") owner = (b.owner.AddressOwner ?? null);
    if ((owner ?? "").toLowerCase() !== me) continue;
    const amt = Number(b.amount ?? "0");
    myUsdsui += amt / 1e6;
  }
  return myUsdsui;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`address:  ${TARGET_ADDR}`);
  console.log(`network:  ${NETWORK}`);

  const net = NETWORK === "testnet" ? "testnet" : "mainnet";
  const url = getFullnodeUrl(net);
  const client = new SuiClient({ url, network: net });

  // Resolve the Talise PK registry id deterministically.
  let registryId = null;
  try {
    const pk = new PaymentKitClient({ client });
    registryId = pk.getRegistryIdFromName("talise");
    console.log(`registry: ${registryId}`);
  } catch (e) {
    console.log(`registry resolution failed: ${e.message} — continuing with venue-pkg heuristic only`);
  }

  // Pull a deep tx history (paginate). Mirror lib/activity's two-filter sweep.
  const OPTS = {
    showEffects: true,
    showBalanceChanges: true,
    showObjectChanges: true,
    showInput: true,
  };
  async function pageAll(filter, maxScan = 800) {
    const out = [];
    let cursor = null;
    let scanned = 0;
    while (scanned < maxScan) {
      const limit = Math.min(50, maxScan - scanned);
      const page = await client.queryTransactionBlocks({
        filter, options: OPTS, limit, order: "descending", cursor,
      });
      for (const t of page.data ?? []) out.push(t);
      scanned += (page.data ?? []).length;
      if (!page.hasNextPage || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  let from = [], to = [];
  try {
    [from, to] = await Promise.all([
      pageAll({ FromAddress: TARGET_ADDR }, 800),
      pageAll({ ToAddress: TARGET_ADDR }, 800),
    ]);
  } catch (e) {
    console.log(`tx history fetch failed: ${e.message}`);
  }
  console.log(`fetched: ${from.length} FromAddress + ${to.length} ToAddress txs`);

  // Dedupe.
  const byDigest = new Map();
  for (const t of [...from, ...to]) {
    if (t.digest && !byDigest.has(t.digest)) byDigest.set(t.digest, t);
  }
  console.log(`unique: ${byDigest.size} digests`);

  // Walk and classify.
  const navi = [];
  for (const tx of byDigest.values()) {
    if (tx.effects?.status?.status !== "success") continue;
    const memos = registryId ? parseAllPaymentRecords(tx, registryId) : [];
    const investMemo = memos.find((m) => m.kind === "invest" && m.refs?.venue === "navi");
    const withdrawMemo = memos.find((m) => m.kind === "withdraw" && m.refs?.venue === "navi");
    const venueClass = classifyVenueRaw(tx);
    let direction = null, amountUsdsui = 0, source = null;

    if (investMemo) {
      direction = "invest";
      amountUsdsui = Math.abs(summarizeUserUsdsuiDelta(tx, TARGET_ADDR)) || investMemo.amountUsdsui;
      source = "PK-memo:invest";
    } else if (withdrawMemo) {
      direction = "withdraw";
      amountUsdsui = Math.abs(summarizeUserUsdsuiDelta(tx, TARGET_ADDR)) || withdrawMemo.amountUsdsui;
      source = "PK-memo:withdraw";
    } else if (venueClass && venueClass.venue === "navi") {
      direction = venueClass.kind;
      amountUsdsui = Math.abs(summarizeUserUsdsuiDelta(tx, TARGET_ADDR));
      source = "heuristic-pkg";
    } else {
      continue; // not a navi tx
    }

    navi.push({
      digest: tx.digest,
      ts: Number(tx.timestampMs || 0),
      tsIso: new Date(Number(tx.timestampMs || 0)).toISOString(),
      direction,
      amountUsdsui,
      source,
    });
  }
  navi.sort((a, b) => b.ts - a.ts);

  console.log("\nNavi-related activity rows:");
  if (navi.length === 0) {
    console.log("  (none — either no navi history or history not visible to this RPC)");
  } else {
    for (const r of navi) {
      console.log(`  ${r.tsIso}  ${r.direction.padEnd(9)}  ${r.amountUsdsui.toFixed(6).padStart(14)} USDsui  [${r.source}]  ${r.digest}`);
    }
  }

  // ----- NaviAdapter.getPositions for the current redeemable value -----
  console.log("\nNaviAdapter.getPositions():");
  let currentValue = 0;
  let rawAdapterRow = null;
  try {
    const a = new NaviAdapter();
    await a.init(client);
    const positions = await a.getPositions(TARGET_ADDR);
    const row = positions.supplies.find(
      (s) => s.asset === "USDsui" || s.asset.toLowerCase() === "usdsui"
    );
    rawAdapterRow = row || null;
    currentValue = row?.amount ?? 0;
    console.log(`  supplies: ${JSON.stringify(positions.supplies, null, 2)}`);
    if (positions.borrows && positions.borrows.length) {
      console.log(`  borrows: ${JSON.stringify(positions.borrows, null, 2)}`);
    }
  } catch (e) {
    console.log(`  ERROR ${e.message}`);
  }

  // ----- Side-by-side math -----
  let supplies = 0, withdraws = 0;
  for (const r of navi) {
    if (r.direction === "invest") supplies += r.amountUsdsui;
    else if (r.direction === "withdraw") withdraws += r.amountUsdsui;
  }
  const principalNet = supplies - withdraws;

  console.log("\nReplay summary (REAL):");
  console.log(`  Supplies seen:    sum = ${supplies.toFixed(6)} USDsui (${navi.filter(r=>r.direction==='invest').length} rows)`);
  console.log(`  Withdraws seen:   sum = ${withdraws.toFixed(6)} USDsui (${navi.filter(r=>r.direction==='withdraw').length} rows)`);
  console.log(`  Principal net:    ${principalNet.toFixed(6)} USDsui  (naive)`);
  console.log(`  Current LP value: ${currentValue.toFixed(6)} USDsui  (raw amount=${rawAdapterRow?.amount ?? 'n/a'}, amountUsd=${rawAdapterRow?.amountUsd ?? 'n/a'})`);

  // Apply the SAME logic as naviPositionFromActivity (post-fix).
  const apy = rawAdapterRow?.apy ?? 0.0873;
  const detail = naviPositionFromActivityLocal({
    currentValue,
    apy,
    naviActivity: navi.map(r => ({
      direction: r.direction,
      venue: "navi",
      amountUsdsui: r.amountUsdsui,
      timestampMs: r.ts,
    })),
  });
  console.log(`\nPost-fix naviPositionFromActivity output:`);
  console.log(`  apy:              ${(detail.apy * 100).toFixed(2)}%`);
  console.log(`  currentValue:     ${detail.currentValue.toFixed(6)} USDsui`);
  console.log(`  principalSupplied:${detail.principalSupplied.toFixed(6)} USDsui`);
  console.log(`  earned:           ${detail.earned.toFixed(6)} USDsui  ${detail.earned > 0 ? "(>0 ✓)" : "(=0)"}`);
  console.log(`  dailyEarning:     ${detail.dailyEarning.toFixed(6)} USDsui/day`);

  if (currentValue === 0 || (navi.length === 0 && currentValue === 0)) {
    console.log("\nWARNING: real-data path produced no signal. Running SYNTHETIC test.");
    runSynthetic();
  } else {
    console.log("\nSYNTHETIC test cases (sanity):");
    runSynthetic();
  }
}

// Mirror lib/navi-supply.ts `naviPositionFromActivity` so the debug
// script reflects the fix even before the dev server boots.
function naviPositionFromActivityLocal({ currentValue, apy, naviActivity }) {
  let supplied = 0, withdrawn = 0, sawAny = false;
  let earliestInvestTs = null;
  for (const row of naviActivity) {
    if ((row.venue ?? "").toLowerCase() !== "navi") continue;
    const amt = Math.abs(row.amountUsdsui ?? 0);
    if (amt <= 0) continue;
    if (row.direction === "invest") {
      supplied += amt; sawAny = true;
      const ts = row.timestampMs ?? null;
      if (ts && (earliestInvestTs === null || ts < earliestInvestTs)) earliestInvestTs = ts;
    } else if (row.direction === "withdraw") {
      withdrawn += amt; sawAny = true;
    }
  }
  const dailyEarning = currentValue * apy / 365;
  if (!sawAny) {
    return { currentValue, principalSupplied: currentValue, earned: 0, dailyEarning, apy };
  }
  const naiveNetDeposited = Math.max(0, supplied - withdrawn);
  if (naiveNetDeposited <= currentValue) {
    return {
      currentValue,
      principalSupplied: naiveNetDeposited,
      earned: Math.max(0, currentValue - naiveNetDeposited),
      dailyEarning, apy,
    };
  }
  if (earliestInvestTs !== null && earliestInvestTs > 0 && apy > 0) {
    const yearsSinceFirst = Math.max(0, (Date.now() - earliestInvestTs) / (365 * 24 * 60 * 60 * 1000));
    const projected = Math.min(currentValue * 0.1, currentValue * apy * yearsSinceFirst);
    const projectedEarned = Math.max(0, projected);
    return {
      currentValue,
      principalSupplied: Math.max(0, currentValue - projectedEarned),
      earned: projectedEarned,
      dailyEarning, apy,
    };
  }
  return { currentValue, principalSupplied: currentValue, earned: 0, dailyEarning, apy };
}

// ---------------------------------------------------------------------------
// Synthetic case — proves the math, doesn't need on-chain visibility.
// Mirrors a user who supplied 1.4404 USDsui hours ago at 8.73% APY and
// has accrued some interest into a current value of 1.4421 (+0.0017).
// ---------------------------------------------------------------------------
function runSynthetic() {
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const cases = [
    {
      name: "happy: supplied 1.4404, accrued 0.0017 over a few hours",
      currentValue: 1.4421,
      apy: 0.0873,
      activity: [
        { direction: "invest", venue: "navi", amountUsdsui: 1.4404, timestampMs: now - 6 * HOUR },
      ],
      expect: (r) => r.earned >= 0.0015,
    },
    {
      name: "supplied + partial withdraw → naive principal fits",
      currentValue: 0.6005,
      apy: 0.0873,
      activity: [
        { direction: "invest", venue: "navi", amountUsdsui: 1.0, timestampMs: now - 30 * DAY },
        { direction: "withdraw", venue: "navi", amountUsdsui: 0.4, timestampMs: now - 1 * DAY },
      ],
      expect: (r) => r.earned >= 0.0001,
    },
    {
      name: "missing history → fallback (principal=current, earned=0)",
      currentValue: 1.4421,
      apy: 0.0873,
      activity: [],
      expect: (r) => r.earned === 0 && r.principalSupplied === 1.4421,
    },
    {
      name: "dust-rounding (REAL user): naive principal > current → time-weighted projection",
      currentValue: 1.020545,
      apy: 0.0873,
      activity: [
        { direction: "invest", venue: "navi", amountUsdsui: 1.512885, timestampMs: now - 3 * DAY },
        { direction: "withdraw", venue: "navi", amountUsdsui: 0.197922, timestampMs: now - 1 * HOUR },
      ],
      expect: (r) => r.earned > 0,
    },
    {
      name: "long-tenured user: projection clamps to 10% of currentValue",
      currentValue: 1.0,
      apy: 0.0873,
      activity: [
        { direction: "invest", venue: "navi", amountUsdsui: 5.0, timestampMs: now - 5 * 365 * DAY },
      ],
      expect: (r) => r.earned > 0 && r.earned <= 0.1,
    },
  ];

  let allPass = true;
  for (const c of cases) {
    const r = naviPositionFromActivityLocal({
      currentValue: c.currentValue,
      apy: c.apy,
      naviActivity: c.activity,
    });
    const pass = c.expect(r);
    if (!pass) allPass = false;
    console.log(`  [${pass ? "PASS" : "FAIL"}] ${c.name}`);
    console.log(`        currentValue=${r.currentValue.toFixed(6)}  principalSupplied=${r.principalSupplied.toFixed(6)}  earned=${r.earned.toFixed(6)}  dailyEarning=${r.dailyEarning.toFixed(6)}`);
  }
  if (!allPass) {
    console.log("\n  *** SYNTHETIC FAILURES ***");
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
