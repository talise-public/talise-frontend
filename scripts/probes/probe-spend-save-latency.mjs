#!/usr/bin/env node
/**
 * probe-spend-save-latency.mjs
 *
 * MEASURES the real cost of bundling the Spend + Save NAVI supply leg into a
 * send PTB on the SPONSORED rail, which is the exact thing the 2026-06-22
 * decoupling (ae578f42) removed with the note "that combined shared-object PTB
 * blew the sponsor window (send+save timed out)".
 *
 * What it times, per endpoint:
 *   1. Onara /status              (sponsor address + reference gas price legs)
 *   2. NaviAdapter.init()         COLD  — the suspected cost
 *   3. appendNaviSupply()         WARM  — repeated, so we see the marginal cost
 *   4. tx.build({client})         send-only vs send+save, sponsored shape
 *   5. simulateTransaction()      does the combined PTB actually EXECUTE, and
 *                                 what does the validator charge for it
 *
 * Read-only. Nothing is signed, nothing is broadcast, no money moves.
 *
 * Run:  cd web && node --env-file=.env.local scripts/probes/probe-spend-save-latency.mjs [senderAddress]
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { NaviAdapter } from "@t2000/sdk";
import { PaymentKitClient } from "@mysten/payment-kit";

const USDSUI_TYPE =
  "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const SENDER = (
  process.argv[2] ||
  "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c"
).toLowerCase();
const RECIPIENT =
  "0xc0bf1c51e44f8cfa4a06f16a2408effa3507ac4582744c7ead56078b5e251a48";
const PAYMENT_KIT_PACKAGE =
  "0xbc126f1535fba7d641cb9150ad9eae93b104972586ba20f3c60bfe0e53b69bc6";
const SAVE_TREASURY_FEE_BPS = 100n;
const SPONSOR_GAS_BUDGET_MIST = 60_000_000n;

const ENDPOINTS = [
  {
    name: "hayabusa (prod read head)",
    url:
      process.env.HAYABUSA_GRPC_URL ||
      "https://hayabusa.mainnet.unconfirmed.cloud:443",
  },
  { name: "fullnode.mainnet.sui.io", url: "https://fullnode.mainnet.sui.io:443" },
];

const ms = (t0) => Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
const now = () => process.hrtime.bigint();

// ── compat client for NaviAdapter (mirror of lib/navi-grpc-client.ts) ──────
function wrapFields(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(wrapFields);
  if (typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = wrapFields(x);
    return { fields: o };
  }
  return v;
}
function jsonToContentFields(j) {
  if (j === null || typeof j !== "object" || Array.isArray(j)) return {};
  const o = {};
  for (const [k, v] of Object.entries(j)) o[k] = wrapFields(v);
  return o;
}
function grpcObjectToJsonRpc(obj) {
  if (!obj) return { data: null };
  const content =
    obj.json && typeof obj.json === "object"
      ? { dataType: "moveObject", type: obj.type, fields: jsonToContentFields(obj.json) }
      : null;
  return {
    data: {
      objectId: obj.objectId,
      version: String(obj.version),
      digest: obj.digest,
      type: obj.type,
      content,
    },
  };
}
function serializeDynamicFieldName(name) {
  const t = name.type;
  if (t === "vector<u8>") {
    const v = name.value;
    const bytes =
      typeof v === "string" ? Array.from(new TextEncoder().encode(v)) : Array.isArray(v) ? v : [];
    return bcs.vector(bcs.u8()).serialize(bytes).toBytes();
  }
  if (/::price_identifier::PriceIdentifier$/.test(t)) {
    const inner = name.value?.bytes ?? [];
    const PI = bcs.struct("PriceIdentifier", { bytes: bcs.vector(bcs.u8()) });
    return PI.serialize({ bytes: inner }).toBytes();
  }
  const mb = name.value?.bytes;
  if (Array.isArray(mb)) return bcs.vector(bcs.u8()).serialize(mb).toBytes();
  throw new Error(`unsupported dynamic field name type: ${t}`);
}
function compat(grpc) {
  return {
    async devInspectTransactionBlock(params) {
      const res = await grpc.simulateTransaction({
        transaction: params.transactionBlock,
        checksEnabled: false,
        include: { commandResults: true },
      });
      return {
        results: (res.commandResults ?? []).map((cr) => ({
          returnValues: (cr.returnValues ?? []).map((rv) => [rv.bcs ? Array.from(rv.bcs) : [], ""]),
        })),
      };
    },
    async getObject(params) {
      try {
        const res = await grpc.getObject({ objectId: params.id, include: { json: true } });
        return grpcObjectToJsonRpc(res.object);
      } catch (err) {
        return { data: null, error: err };
      }
    },
    async multiGetObjects(params) {
      const res = await grpc.getObjects({ objectIds: params.ids, include: { json: true } });
      return (res.objects ?? []).map((o) =>
        o instanceof Error ? { data: null, error: o } : grpcObjectToJsonRpc(o)
      );
    },
    async getDynamicFieldObject(params) {
      try {
        const nameBcs = serializeDynamicFieldName(params.name);
        const df = await grpc.getDynamicField({
          parentId: params.parentId,
          name: { type: params.name.type, bcs: nameBcs },
        });
        const dfld = df.dynamicField;
        if (!dfld) return { data: null };
        const targetId = dfld.childId ?? dfld.fieldId;
        const objRes = await grpc.getObject({ objectId: targetId, include: { json: true } });
        return grpcObjectToJsonRpc(objRes.object);
      } catch (err) {
        return { data: null, error: err };
      }
    },
    async getCoins(params) {
      const res = await grpc.listCoins({
        owner: params.owner,
        coinType: params.coinType,
        cursor: params.cursor ?? undefined,
      });
      return {
        data: (res.objects ?? []).map((c) => ({
          coinObjectId: c.objectId,
          version: String(c.version),
          digest: c.digest,
          balance: c.balance,
          coinType: c.type,
        })),
        hasNextPage: !!res.hasNextPage,
        nextCursor: res.cursor ?? null,
      };
    },
    async getBalance(params) {
      const res = await grpc.getBalance({ owner: params.owner, coinType: params.coinType });
      return {
        coinType: res.balance?.coinType ?? params.coinType,
        totalBalance: res.balance?.balance ?? "0",
        coinObjectCount: 0,
        lockedBalance: {},
      };
    },
  };
}

// ── mirrors of the shipped builders ───────────────────────────────────────
function pkNonce(kind, sender, receiver, venue) {
  const KIND = { send: "s", invest: "i" };
  const ts = Date.now().toString(36).padStart(8, "0").slice(-8);
  const rand = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0");
  return (
    "t1" +
    KIND[kind] +
    ts +
    rand +
    sender.replace(/^0x/, "").slice(0, 6) +
    receiver.replace(/^0x/, "").slice(0, 6) +
    (venue === "navi" ? "n" : "")
  );
}

/** lib/intents/wrap-payment-kit.ts → appendPaymentKitReceipt */
function appendPaymentKitReceipt(tx, registryId, usdsuiType, opts) {
  const receiver = opts.receiver ?? opts.sender;
  const isTransfer = opts.kind === "send";
  const amountMicro = isTransfer ? BigInt(Math.round(opts.amountUsdsui * 1e6)) : 1n;
  const nonce = pkNonce(opts.kind, opts.sender, receiver, opts.venue);
  const coin = tx.add(
    coinWithBalance({ type: usdsuiType, balance: amountMicro, useGasCoin: false })
  );
  const receiverOpt = tx.moveCall({
    target: "0x1::option::some",
    typeArguments: ["address"],
    arguments: [tx.pure.address(receiver)],
  });
  tx.moveCall({
    package: PAYMENT_KIT_PACKAGE,
    module: "payment_kit",
    function: "process_registry_payment",
    typeArguments: [usdsuiType],
    arguments: [
      tx.object(registryId),
      tx.pure.string(nonce),
      tx.pure.u64(amountMicro),
      coin,
      receiverOpt,
      tx.object("0x6"),
    ],
  });
  return nonce;
}

/** lib/usdsui-coin.ts → sourceUsdsuiCoin */
async function sourceUsdsuiCoin(tx, grpc, usdsuiType, sender, micros) {
  let coinTotal = 0n;
  try {
    const res = await grpc.listCoins({ owner: sender, coinType: usdsuiType });
    for (const o of res.objects ?? []) coinTotal += BigInt(o.balance ?? "0");
  } catch {
    /* fall through to accumulator */
  }
  if (coinTotal >= micros) {
    return tx.add(coinWithBalance({ type: usdsuiType, balance: micros, useGasCoin: false }));
  }
  return tx.moveCall({
    target: "0x2::coin::from_balance",
    typeArguments: [usdsuiType],
    arguments: [tx.balance({ type: usdsuiType, balance: micros })],
  });
}

/** lib/navi-supply.ts → appendNaviSupply (with the 1% treasury fee leg) */
async function appendNaviSupply(tx, grpc, adapter, usdsuiType, sender, amountUsdsui) {
  const onchain = BigInt(Math.round(amountUsdsui * 1e6));
  const coin = await sourceUsdsuiCoin(tx, grpc, usdsuiType, sender, onchain);
  const fee = (onchain * SAVE_TREASURY_FEE_BPS) / 10_000n;
  if (fee > 0n) {
    const [feeCoin] = tx.splitCoins(coin, [fee]);
    tx.transferObjects([feeCoin], RECIPIENT);
  }
  await adapter.addSaveToTx(tx, sender, coin, "USDsui");
}

function cmdSummary(tx) {
  const cmds = tx.getData().commands ?? [];
  const c = {};
  for (const cmd of cmds) {
    const mc = cmd.MoveCall ?? (cmd.$kind === "MoveCall" ? cmd : null);
    const k = mc ? `${mc.module}::${mc.function}` : cmd.$kind ?? Object.keys(cmd)[0];
    c[k] = (c[k] || 0) + 1;
  }
  return { total: cmds.length, counts: c };
}

function simStatus(sim) {
  if (sim?.$kind === "Transaction") return "SUCCESS";
  const st = sim?.FailedTransaction?.effects?.status;
  const reason =
    (typeof st === "object" && st?.error ? st.error.description ?? st.error.message : undefined) ??
    (typeof st === "string" ? st : JSON.stringify(st ?? sim?.$kind));
  return `FAILED (${reason})`;
}
function simGasMist(sim) {
  const fx = sim?.Transaction?.effects ?? sim?.FailedTransaction?.effects;
  const g = fx?.gasUsed ?? fx?.gas_used;
  if (!g) return null;
  const n = (v) => BigInt(v ?? 0);
  try {
    return n(g.computationCost) + n(g.storageCost) - n(g.storageRebate);
  } catch {
    return null;
  }
}

async function run(endpoint, usdsuiType, sponsor, gasPrice) {
  console.log(`\n${"─".repeat(72)}\nENDPOINT: ${endpoint.name}\n  ${endpoint.url}`);
  const grpc = new SuiGrpcClient({ network: "mainnet", baseUrl: endpoint.url });

  // Sender balance + coin shape (decides which sourceUsdsuiCoin branch runs).
  let bal = 0n;
  let coinCount = 0;
  try {
    const b = await grpc.getBalance({ owner: SENDER, coinType: usdsuiType });
    bal = BigInt(b.balance?.balance ?? "0");
    const lc = await grpc.listCoins({ owner: SENDER, coinType: usdsuiType });
    coinCount = (lc.objects ?? []).length;
  } catch (e) {
    console.log(`  balance read failed: ${e.message}`);
  }
  console.log(
    `  sender USDsui: ${Number(bal) / 1e6} across ${coinCount} coin object(s)`
  );

  const sendUsd = 0.5;
  const roundupUsd = 0.01; // 2% of $0.50 → the real corridor-sized save
  if (bal < BigInt(Math.round((sendUsd + roundupUsd) * 1e6))) {
    console.log("  SKIP: sender cannot cover send + round-up, PTB builds would be unrealistic");
    return null;
  }

  const pk = new PaymentKitClient({ client: grpc });
  const registryId = pk.getRegistryIdFromName("talise");
  console.log(`  talise registry: ${registryId}`);

  // ── 2. NaviAdapter.init() COLD ──────────────────────────────────────────
  let t = now();
  const adapter = new NaviAdapter();
  await adapter.init(compat(grpc));
  const coldInitMs = ms(t);
  console.log(`\n  [2] NaviAdapter.init()        COLD  ${coldInitMs} ms`);

  // ── 3. appendNaviSupply WARM, repeated ──────────────────────────────────
  const warm = [];
  for (let i = 0; i < 5; i++) {
    const tx = new Transaction();
    tx.setSender(SENDER);
    t = now();
    try {
      await appendNaviSupply(tx, grpc, adapter, usdsuiType, SENDER, roundupUsd);
      warm.push(ms(t));
    } catch (e) {
      console.log(`      run ${i + 1} threw: ${e.message}`);
      warm.push(null);
    }
  }
  const okWarm = warm.filter((x) => x != null).sort((a, b) => a - b);
  console.log(
    `  [3] appendNaviSupply()       WARM  runs=[${warm.join(", ")}] ms` +
      (okWarm.length
        ? `  → min ${okWarm[0]} / median ${okWarm[Math.floor(okWarm.length / 2)]} / max ${okWarm[okWarm.length - 1]}`
        : "")
  );

  // ── 4/5. Sponsored PTB build + simulate, send-only vs send+save ─────────
  const results = {};
  for (const withSave of [false, true]) {
    const label = withSave ? "send+save" : "send-only";
    const tAll = now();
    const tx = new Transaction();
    tx.setSender(SENDER);
    t = now();
    appendPaymentKitReceipt(tx, registryId, usdsuiType, {
      kind: "send",
      sender: SENDER,
      receiver: RECIPIENT,
      amountUsdsui: sendUsd,
    });
    const pkMs = ms(t);
    let naviMs = 0;
    if (withSave) {
      t = now();
      try {
        await appendNaviSupply(tx, grpc, adapter, usdsuiType, SENDER, roundupUsd);
        appendPaymentKitReceipt(tx, registryId, usdsuiType, {
          kind: "invest",
          sender: SENDER,
          venue: "navi",
        });
      } catch (e) {
        console.log(`  [${label}] navi append FAILED: ${e.message}`);
        continue;
      }
      naviMs = ms(t);
    }
    tx.setGasOwner(sponsor);
    tx.setGasPrice(BigInt(gasPrice));
    tx.setGasBudget(SPONSOR_GAS_BUDGET_MIST);
    t = now();
    let bytes;
    try {
      bytes = await tx.build({ client: grpc });
    } catch (e) {
      console.log(`  [${label}] tx.build FAILED after ${ms(t)} ms: ${e.message}`);
      continue;
    }
    const buildMs = ms(t);
    const prepareTotalMs = ms(tAll);
    const shape = cmdSummary(tx);

    t = now();
    let sim = null;
    let simMs = 0;
    try {
      sim = await grpc.simulateTransaction({ transaction: bytes, include: { effects: true } });
      simMs = ms(t);
    } catch (e) {
      simMs = ms(t);
      sim = { $kind: "error", FailedTransaction: { effects: { status: e.message } } };
    }
    const gas = simGasMist(sim);
    results[label] = { prepareTotalMs, buildMs, naviMs, simMs, shape, sim };

    console.log(
      `\n  [4] ${label.padEnd(9)} PTB: ${shape.total} commands, ${bytes.length} bytes\n` +
        `      pk=${pkMs}ms navi=${naviMs}ms tx.build=${buildMs}ms  → prepare work total ${prepareTotalMs} ms\n` +
        `      commands: ${JSON.stringify(shape.counts)}\n` +
        `  [5] simulateTransaction: ${simMs} ms → ${simStatus(sim)}` +
        (gas != null ? `  gas=${Number(gas) / 1e9} SUI` : "")
    );
  }
  return results;
}

/**
 * MODE=cold|prewarm — isolates the cold cost of the NAVI leg in a FRESH
 * process, which is the only way to see it: @t2000/sdk caches pool + reserve
 * + oracle metadata process-globally, so the second endpoint in a `full` run
 * is already warm and reads like ~200ms when the truth is seconds.
 *
 *   cold     init() → appendNaviSupply x N. Run 1 IS the cold number.
 *   prewarm  init() → getPositions() → appendNaviSupply x N. Answers "can a
 *            warmup route pay the cold cost so the user's send never does?"
 */
async function runColdModes(mode, usdsuiType) {
  const url = process.env.PROBE_GRPC_URL || ENDPOINTS[0].url;
  const grpc = new SuiGrpcClient({ network: "mainnet", baseUrl: url });
  console.log(`MODE=${mode}  endpoint=${url}\n`);

  let t = now();
  const adapter = new NaviAdapter();
  await adapter.init(compat(grpc));
  console.log(`  NaviAdapter.init()            ${ms(t)} ms  (lazy — does no network work)`);

  if (mode === "prewarm") {
    t = now();
    try {
      await adapter.getPositions(SENDER);
      console.log(`  getPositions() [warmup call]  ${ms(t)} ms`);
    } catch (e) {
      console.log(`  getPositions() FAILED after ${ms(t)} ms: ${e.message}`);
    }
  }

  // Does warming through a DIFFERENT address make the hot path fast for THIS
  // one? It has to, for /api/zk/warmup to be able to stay unauthenticated: the
  // expensive caches (pool registry, reserve metadata, Pyth tables) are global,
  // only the listCoins read is per-address.
  if (mode === "prewarm-other") {
    t = now();
    try {
      const warmTx = new Transaction();
      warmTx.setSender(RECIPIENT);
      await appendNaviSupply(warmTx, grpc, adapter, usdsuiType, RECIPIENT, 0.01);
      console.log(`  appendNaviSupply(OTHER addr)  ${ms(t)} ms  [warmup call]`);
    } catch (e) {
      console.log(`  warmup via other addr FAILED after ${ms(t)} ms: ${e.message}`);
    }
  }

  const runs = [];
  const N = Number(process.env.PROBE_RUNS || 10);
  for (let i = 0; i < N; i++) {
    const tx = new Transaction();
    tx.setSender(SENDER);
    t = now();
    try {
      await appendNaviSupply(tx, grpc, adapter, usdsuiType, SENDER, 0.01);
      runs.push(ms(t));
    } catch (e) {
      console.log(`    run ${i + 1} threw after ${ms(t)} ms: ${e.message}`);
      runs.push(null);
    }
  }
  console.log(`\n  appendNaviSupply() x${N}: [${runs.join(", ")}] ms`);
  const ok = runs.filter((x) => x != null);
  const sorted = [...ok].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  console.log(`  run 1 (COLD): ${runs[0]} ms`);
  const warm = ok.slice(1).sort((a, b) => a - b);
  const wpct = (p) => warm[Math.min(warm.length - 1, Math.floor((p / 100) * warm.length))];
  if (warm.length) {
    console.log(
      `  WARM (runs 2+): p50 ${wpct(50)} ms · p95 ${wpct(95)} ms · min ${warm[0]} · max ${warm[warm.length - 1]}`
    );
  }
  console.log(`  ALL: p50 ${pct(50)} ms · p95 ${pct(95)} ms`);
}

async function main() {
  console.log("Spend + Save latency probe — read-only, nothing is signed or broadcast");
  console.log(`sender: ${SENDER}`);

  // Resolve the real USDsui type the same way lib/usdsui.ts does.
  const { USDSUI_TYPE: envType } = { USDSUI_TYPE: process.env.USDSUI_COIN_TYPE };
  const usdsuiType = envType || USDSUI_TYPE;
  console.log(`USDsui: ${usdsuiType}`);

  const mode = process.env.MODE ?? "full";
  if (mode === "cold" || mode === "prewarm" || mode === "prewarm-other") {
    await runColdModes(mode, usdsuiType);
    return;
  }

  // ── 1. Onara /status + reference gas price ──────────────────────────────
  const onaraUrl = process.env.ONARA_URL;
  let sponsor = null;
  if (!onaraUrl) {
    console.log("\n  [1] ONARA_URL unset — cannot measure the sponsor leg");
  } else {
    const t = now();
    try {
      const r = await fetch(`${onaraUrl.replace(/\/$/, "")}/status`, {
        signal: AbortSignal.timeout(15_000),
      });
      const body = await r.json();
      sponsor = body?.address ?? null;
      console.log(`\n  [1] Onara /status: ${ms(t)} ms → sponsor=${sponsor}`);
    } catch (e) {
      console.log(`\n  [1] Onara /status FAILED after ${ms(t)} ms: ${e.message}`);
    }
  }
  if (!sponsor) {
    // Still measurable: use the sender as its own gas owner so the build runs.
    sponsor = SENDER;
    console.log("      falling back to sender-as-gas-owner so the build still runs");
  }

  const probe = new SuiGrpcClient({
    network: "mainnet",
    baseUrl: ENDPOINTS[1].url,
  });
  let gasPrice = 1000n;
  const tg = now();
  try {
    const r = await probe.getReferenceGasPrice();
    gasPrice = BigInt(r.referenceGasPrice);
    console.log(`      referenceGasPrice: ${ms(tg)} ms → ${gasPrice}`);
  } catch (e) {
    console.log(`      referenceGasPrice failed (${e.message}), using ${gasPrice}`);
  }

  for (const ep of ENDPOINTS) {
    try {
      await run(ep, usdsuiType, sponsor, gasPrice);
    } catch (e) {
      console.log(`  endpoint aborted: ${e.stack ?? e.message}`);
    }
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
