// Shielded-pool RECOVERY sweep — reclaim user 1's 18 unspent USDsui notes
// ($2.90) to their own wallet. DRY by default; only `--execute` submits.
//
//   node --loader ./scripts/shield-node-loader.mjs scripts/shield-recover-execute.mjs          # DRY
//   node --loader ./scripts/shield-node-loader.mjs scripts/shield-recover-execute.mjs --execute # REAL
//
// The note master is read from the DB escrow and NEVER printed. Nothing is
// signed or submitted unless BOTH --execute is passed AND the prover seam
// (proveNoteWithdraw) is wired — see the BLOCKER note at that function.
//
// SAFETY MODEL
//   • DRY (default): recover master → derive keys → rebuild the on-chain Merkle
//     tree from the indexed leaves → ASSERT rebuilt root == live on-chain root →
//     scan + filter to unspent notes → generate each note's authentication path
//     → assemble the withdraw witness. NO proof, NO PTB, NO submit.
//   • EXECUTE: additionally prove each note, build the transact PTB, validate it
//     through the REAL relayer allowlist, persist a crash-safe artifact, then
//     POST /api/shield/relay. Refuses to start until the prover seam is wired.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { deriveShieldKeypairFromSeed, deriveShieldEncScalar, poseidonStub } from "../lib/shield/sdk/keys.ts";
import { scanNotes } from "../lib/shield/sdk/scan.ts";
import { buildLevels, pathFor } from "../lib/shield/merkle.ts";

// ── Pinned mainnet wiring (matches shield-mainnet-lifecycle.mjs / Vercel SHIELD_*) ──
const RPC = "https://fullnode.mainnet.sui.io:443";
const PKG = "0x8722790773958722225cf91f5a6762689dc13f97076534c05ebd3505d586f9bf";
const POOL = "0x6bcd28763456db543d0c29acb34970b81e4d7f004d2581fce46b813ece8152c1";
const MERKLE_TREE_DOF = "0x8e60af49055d1cec29e7ed6c5814157d5c6a499f123f4c7e4236811419ecbd7e";
const USDSUI = "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";

const EXECUTE = process.argv.includes("--execute");
const VALIDATE_FIRST = process.argv.includes("--validate-first");
const COIN_TYPE = USDSUI;
const CIRCUIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../move/talise-privacy/circuit");
const PROVER_BIN = path.join(CIRCUIT_DIR, "target/release/prove_note_withdraw");
const USER_ID = process.env.RECOVER_USER_ID || "1";
const EXIT_ADDRESS = (process.env.EXIT_ADDRESS ||
  "0xb9aad5433f0d3b76e35d9985706b3fa9e571262f2fa1f12043589ca681d2866c").toLowerCase();
const API = process.env.SHIELD_API_BASE || "https://app.talise.io";
const ART = path.join(path.dirname(fileURLToPath(import.meta.url)), ".shield-recover-art.json");

const hash3 = (a, b, c) => poseidonStub([a, b, c]);
const nullifierFor = (sk, commitment, pathIndex) =>
  hash3(commitment, pathIndex, hash3(sk, commitment, pathIndex));

// ── DB (read-only) ──────────────────────────────────────────────────────────
const dbUrl = (() => {
  const line = readFileSync(".env.local", "utf8").split("\n").find((l) => l.startsWith("DATABASE_URL="));
  return line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "").split("?")[0] + "?sslmode=require";
})();
const q = (sql) => execFileSync("psql", [dbUrl, "-Atc", sql], { encoding: "utf8" }).trim();

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// The live current root sits at root_history[next_index/2].
async function liveCurrentRoot(nextIndex) {
  const idx = Math.floor(Number(nextIndex) / 2);
  const res = await rpc("suix_getDynamicFieldObject", [MERKLE_TREE_DOF, { type: "u64", value: String(idx) }]);
  return res?.data?.content?.fields?.value ? String(res.data.content.fields.value) : null;
}

// ── PROVER SEAM — BLOCKER ────────────────────────────────────────────────────
// Generate a Groth16 WITHDRAW proof for ONE recovered note. There is currently
// NO Node-callable prover for arbitrary existing notes:
//   • lib/shield/sdk/prover.ts is BROWSER-ONLY (Web Worker + IndexedDB + fetch
//     of /shield/*.wasm) — it does not run under Node.
//   • circuit/src/bin/prove_withdraw.rs has every note value HARDCODED (no CLI
//     args) — a one-shot, not a tool.
//   • circuit/src/bin/prove_lifecycle.rs GENERATES fresh OsRng secrets — it
//     cannot prove a withdraw for a note whose secrets we already hold.
// To wire this, EITHER:
//   (A) add a parameterized Rust bin `prove_note_withdraw` (clone prove_withdraw.rs
//       but read note privKey/amount/blinding/commitment/leafIndex + --existing-leaves
//       from argv), build it, and execFileSync it here; OR
//   (B) drive the browser WASM prover headlessly; OR
//   (C) recover via the in-app shield-exit (the app already runs this prover).
// Runs the parameterized Rust prover for ONE note; native-verifies inside the
// binary. Secrets are passed as argv (not shell) and never logged. `leavesDec`
// is the full ordered list of on-chain commitments (decimal strings).
function proveNoteWithdraw({ spendingKey, amountMicros, blinding, commitment, leafIndex }, leavesDec) {
  if (!existsSync(PROVER_BIN)) {
    throw new Error(`prover not built: ${PROVER_BIN}\n  (cd ${CIRCUIT_DIR} && cargo build --release --bin prove_note_withdraw)`);
  }
  const out = execFileSync(
    PROVER_BIN,
    [
      "--pool", POOL,
      "--privkey", spendingKey,
      "--amount", String(amountMicros),
      "--blinding", blinding,
      "--commitment", commitment,
      "--leaf-index", String(leafIndex),
      "--existing-leaves", leavesDec.join(","),
    ],
    { cwd: CIRCUIT_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 16 * 1024 * 1024 }
  );
  const m = out.match(/BEGIN_NOTE_WITHDRAW_JSON\s*([\s\S]*?)\s*END_NOTE_WITHDRAW_JSON/);
  if (!m) throw new Error("prover did not emit a NOTE_WITHDRAW_JSON block");
  return JSON.parse(m[1].trim());
}

const toPoints = (hex) => Uint8Array.from(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));

// Build the withdraw transact PTB for one note's proof (mirrors the lifecycle
// harness's WITHDRAW leg). Self-owned ECIES blobs for the two zero output notes.
async function buildWithdrawPtb({ buildTransact, encryptNote, encPublicKeyFromScalar }, proof, note, relayer, zeroCoinSourceId) {
  const poolField = BigInt(POOL) % BN254;
  const encKey = encPublicKeyFromScalar(0x5eedn); // self-owned; outputs are zero change
  const enc0 = await encryptNote({ amount: 0n, pubkey: BigInt(proof.output_commitment0), blinding: 3n, pool: poolField }, encKey);
  const enc1 = await encryptNote({ amount: 0n, pubkey: BigInt(proof.output_commitment1), blinding: 4n, pool: poolField }, encKey);
  return buildTransact({
    packageId: PKG,
    coinType: COIN_TYPE,
    poolObjectId: POOL,
    poolAddress: POOL,
    proof: {
      proofPoints: toPoints(proof.proof_hex),
      root: BigInt(proof.root),
      publicValue: BigInt(proof.public_value),
      inputNullifier0: BigInt(proof.input_nullifier0),
      inputNullifier1: BigInt(proof.input_nullifier1),
      outputCommitment0: BigInt(proof.output_commitment0),
      outputCommitment1: BigInt(proof.output_commitment1),
    },
    ext: {
      value: note.amount,
      valueSign: false, // withdraw
      relayer,
      relayerFee: 0n,
      encryptedOutput0: enc0,
      encryptedOutput1: enc1,
    },
    zeroCoinSourceId,
    outputRecipient: EXIT_ADDRESS,
  });
}

// SDK-native object resolution over JSON-RPC so build({onlyTransactionKind}) works
// offline against mainnet state (copied from shield-mainnet-lifecycle.mjs).
function jsonRpcResolutionPlugin() {
  return async (transactionData, _options, next) => {
    const ids = new Set();
    for (const inp of transactionData.inputs)
      if (inp.$kind === "UnresolvedObject" && inp.UnresolvedObject?.objectId) ids.add(inp.UnresolvedObject.objectId);
    if (ids.size > 0) {
      const objs = await rpc("sui_multiGetObjects", [[...ids], { showOwner: true }]);
      const byId = new Map();
      for (const o of objs) { const d = o?.data; if (d) byId.set(d.objectId, { version: String(d.version), digest: d.digest, owner: d.owner }); }
      for (const inp of transactionData.inputs) {
        if (inp.$kind !== "UnresolvedObject") continue;
        const id = inp.UnresolvedObject.objectId;
        const info = byId.get(id);
        if (!info) throw new Error(`object ${id} not found on mainnet`);
        const shared = info.owner?.Shared;
        delete inp.UnresolvedObject;
        inp.$kind = "Object";
        inp.Object = shared
          ? { $kind: "SharedObject", SharedObject: { objectId: id, initialSharedVersion: String(shared.initial_shared_version), mutable: true } }
          : { $kind: "ImmOrOwnedObject", ImmOrOwnedObject: { objectId: id, version: info.version, digest: info.digest } };
      }
    }
    await next();
  };
}

async function main() {
  console.log(`TALISE SHIELDED RECOVERY  (mode: ${EXECUTE ? "EXECUTE" : "DRY-RUN"})`);
  console.log(`user ${USER_ID} → exit ${EXIT_ADDRESS}`);

  // 1. Recover the note master (SECRET — never logged) + derive keys.
  const master = q(`SELECT note_master FROM shield_key_escrow WHERE user_id='${USER_ID}'`);
  if (!/^[0-9a-fA-F]{32,128}$/.test(master)) throw new Error(`no escrowed master for user ${USER_ID}`);
  const seed = Uint8Array.from(master.match(/../g).map((h) => parseInt(h, 16)));
  const keypair = await deriveShieldKeypairFromSeed(seed);
  const viewingKey = await deriveShieldEncScalar(keypair.spendingKey);
  console.log(`✓ recovered master (${seed.length}B, hidden) + derived keys`);

  // 2. Load all USDsui commitments (ordered) → rebuild tree → validate root.
  const rows = q(
    `SELECT leaf_index || '|' || commitment || '|' || coalesce(encrypted_output,'') ` +
      `FROM shield_commitments WHERE coin_type='${USDSUI}' ORDER BY leaf_index`
  ).split("\n").filter(Boolean).map((line) => {
    const i = line.indexOf("|"), j = line.indexOf("|", i + 1);
    return { leafIndex: Number(line.slice(0, i)), commitment: line.slice(i + 1, j), encryptedOutput: line.slice(j + 1) || null };
  });
  const leaves = rows.map((r) => BigInt(r.commitment));
  const leavesDec = leaves.map((l) => l.toString());
  const nextIndex = rows.length;
  const { root: rebuiltRoot } = buildLevels(leaves);
  const onchainRoot = await liveCurrentRoot(nextIndex);
  const rootOk = onchainRoot != null && BigInt(onchainRoot) === rebuiltRoot;
  console.log(`✓ ${rows.length} leaves; rebuilt root ${rootOk ? "== on-chain root ✓" : "!= on-chain root ✗"}`);
  if (!rootOk) {
    console.log(`  rebuilt=${rebuiltRoot}`);
    console.log(`  onchain=${onchainRoot}`);
    throw new Error("Merkle root mismatch — refusing to proceed (tree/leaf reconstruction is wrong).");
  }

  // 3. Scan + filter to UNSPENT notes.
  const dbFetch = async (url) => {
    const after = Number(new URL(url, "http://x").searchParams.get("after") ?? -1);
    const limit = Number(new URL(url, "http://x").searchParams.get("limit") ?? 200);
    return { ok: true, json: async () => ({ items: rows.filter((r) => r.leafIndex > after).slice(0, limit) }) };
  };
  const notes = await scanNotes(viewingKey, { baseUrl: "db://", fetch: dbFetch });
  const unspent = [];
  for (const n of notes) {
    if (n.amount <= 0n || n.leafIndex == null) continue;
    const nf = nullifierFor(keypair.spendingKey, n.commitment, BigInt(n.leafIndex));
    let spent = false;
    try {
      const res = await fetch(`${API}/api/shield/nullifier?coinType=${encodeURIComponent(USDSUI)}&nullifier=${nf}`);
      if (res.ok) { const j = await res.json(); spent = !!(j.spent && j.spent[nf.toString()]); }
    } catch { /* treat as unspent; on-chain is the real guard */ }
    if (!spent) unspent.push(n);
  }
  const totalMicros = unspent.reduce((s, n) => s + n.amount, 0n);
  console.log(`✓ ${unspent.length} unspent notes, total $${(Number(totalMicros) / 1e6).toFixed(2)}`);

  // 4. Per note: generate authentication path + assemble withdraw witness.
  const plan = [];
  for (const n of unspent) {
    const mp = pathFor(leaves, n.leafIndex);
    if (BigInt(mp.root) !== rebuiltRoot) throw new Error(`path root mismatch at leaf ${n.leafIndex}`);
    plan.push({
      leafIndex: n.leafIndex,
      amountMicros: n.amount.toString(),
      witness: {
        privateKey: keypair.spendingKey.toString(),
        publicKey: keypair.publicKey.toString(),
        amount: n.amount.toString(),
        blinding: n.blinding.toString(),
        commitment: n.commitment.toString(),
        leafIndex: n.leafIndex,
        pathPairs: mp.pathPairs,
        pathIndices: mp.pathIndices,
        root: mp.root,
        pool: POOL,
        publicAmount: (BN254_NEG(n.amount)).toString(), // field-negated = withdraw
        exitAddress: EXIT_ADDRESS,
      },
    });
  }
  console.log(`✓ assembled ${plan.length} withdraw witnesses (paths validated against root)`);

  // ── VALIDATE-FIRST: prove + native-verify + build + validate + simulate note #1 ──
  if (VALIDATE_FIRST) {
    const sdk = {
      buildTransact: (await import("../lib/shield/sdk/tx.ts")).buildTransact,
      encryptNote: (await import("../lib/shield/sdk/encrypt.ts")).encryptNote,
      encPublicKeyFromScalar: (await import("../lib/shield/sdk/encrypt.ts")).encPublicKeyFromScalar,
    };
    const { validateTransactCommands } = await import("../lib/shield/validate-commands.ts");
    const { toBase64 } = await import("@mysten/sui/utils");
    const zeroCoinSourceId = process.env.ZERO_COIN_SOURCE_ID ||
      "0x8a1c28a71ddfb123581eef0325c42212f3ce4161a4fc06b1702914c777ad4b27"; // placeholder for sim
    const relayer = (process.env.SHIELD_RELAYER_ADDRESS ||
      "0x37949e572bbc9cd57b7817cf3d309c0fa1b5361e0bc7605f6feffc6b6fdb72af").toLowerCase();
    process.env.SHIELD_PKG ||= PKG;
    process.env.SHIELD_RELAYER_ADDRESS ||= relayer;

    // AUTHORITATIVE recheck: the /api/shield/nullifier feed under-reports spent
    // notes, so re-check every "unspent" note against the on-chain nullifier set.
    const NH_TABLE = "0xeab5c3e2327ac6ccfce076b0568ff5d89a1c57c0a18f9901777c3ca7ab3ae89c";
    let trulyUnspent = 0, trulyMicros = 0n;
    console.log(`\n── authoritative on-chain spent-check of all ${unspent.length} API-"unspent" notes ──`);
    for (const n of unspent) {
      const nf = nullifierFor(keypair.spendingKey, n.commitment, BigInt(n.leafIndex)).toString();
      const df = await rpc("suix_getDynamicFieldObject", [NH_TABLE, { type: "u256", value: nf }]).catch(() => null);
      const spent = !!df?.data;
      if (!spent) { trulyUnspent++; trulyMicros += n.amount; }
      console.log(`  leaf #${n.leafIndex} $${(Number(n.amount) / 1e6).toFixed(2)} → ${spent ? "SPENT (on-chain)" : "unspent ✓"}`);
    }
    console.log(`\n>>> TRULY recoverable (on-chain authoritative): ${trulyUnspent} notes, $${(Number(trulyMicros) / 1e6).toFixed(2)}`);

    const howMany = Math.min(Number(process.env.VALIDATE_N || 1), plan.length);
    for (let k = 0; k < howMany; k++) {
      const p = plan[k];
      const note = unspent.find((n) => n.leafIndex === p.leafIndex);
      console.log(`\n── validating note #${p.leafIndex} ($${(Number(p.amountMicros) / 1e6).toFixed(2)}) ──`);
      // 1) prove (Rust native-verifies against the persisted VK before emitting)
      const proof = proveNoteWithdraw(
        { spendingKey: keypair.spendingKey.toString(), amountMicros: p.amountMicros, blinding: note.blinding.toString(), commitment: note.commitment.toString(), leafIndex: p.leafIndex },
        leavesDec
      );
      console.log(`  proof: native Groth16 verify PASS (root ${proof.root.slice(0, 12)}…, public_value ${proof.public_value.slice(0, 8)}…)`);
      console.log(`  NULLIFIER0(real note)=${proof.input_nullifier0}`);
      console.log(`  NULLIFIER1(dummy)    =${proof.input_nullifier1}`);
      // Authoritative on-chain spent check via the pool's nullifier_hashes Table.
      for (const [lbl, nf] of [["null0(real)", proof.input_nullifier0], ["null1(dummy)", proof.input_nullifier1]]) {
        const df = await rpc("suix_getDynamicFieldObject", ["0xeab5c3e2327ac6ccfce076b0568ff5d89a1c57c0a18f9901777c3ca7ab3ae89c", { type: "u256", value: nf }]).catch(() => null);
        console.log(`  on-chain nullifier_hashes[${lbl}] = ${df?.data ? "PRESENT (spent)" : "absent (unspent)"}`);
      }
      // Resolve who owns the zero-coin so the sim sender == ext.relayer (self-relay
      // form): the proof binds pool/value/nullifiers, NOT the relayer, so this
      // exercises the SAME on-chain Groth16 verify the real relayed submit would.
      const zeroOwner = ((await rpc("sui_getObject", [zeroCoinSourceId, { showOwner: true }]))?.data?.owner?.AddressOwner || relayer).toLowerCase();
      // 2) build the withdraw PTB with the PINNED relayer (validateTransactCommands
      //    requires it). A relayer-OWNED zero-coin makes sender==ext.relayer, so
      //    assert_relayer passes and the on-chain Groth16 verify actually runs.
      const tx = await buildWithdrawPtb(sdk, proof, note, relayer, zeroCoinSourceId);
      const json = await tx.toJSON();
      // 3) relayer allowlist must ACCEPT it
      const v = validateTransactCommands(json, { exitAddress: EXIT_ADDRESS });
      console.log(`  relayer validateTransactCommands: ACCEPTED (fn=${v.fn} relayer=${String(v.relayer).slice(0, 10)}… fee=${String(v.relayerFee)})`);
      // 4) mainnet devInspect/simulate (no funds spent)
      try {
        tx.addBuildPlugin(jsonRpcResolutionPlugin());
        const kind = await tx.build({ onlyTransactionKind: true });
        const sim = await rpc("sui_devInspectTransactionBlock", [zeroOwner, toBase64(kind)]);
        const status = sim?.effects?.status?.status;
        console.log(`  mainnet devInspect: status=${status}${status !== "success" ? " err=" + JSON.stringify(sim?.effects?.status) : " ✓ (on-chain Groth16 verify + nullifier + root checks PASS)"}`);
      } catch (e) {
        console.log(`  devInspect could not resolve object refs (${e.message.split("\n")[0]}).`);
        console.log(`  With a REAL relayer-owned ZERO_COIN_SOURCE_ID this resolves + simulates.`);
      }
    }
    console.log("\n=== VALIDATE-FIRST complete — proof(s) verified + PTB validated. NOTHING submitted. ===");
    return;
  }

  if (!EXECUTE) {
    console.log("\n=== DRY RUN complete — NOTHING signed or submitted ===");
    for (const p of plan) console.log(`  leaf #${p.leafIndex}  $${(Number(p.amountMicros) / 1e6).toFixed(2)}  path✓`);
    console.log(`\nWould sweep $${(Number(totalMicros) / 1e6).toFixed(2)} to ${EXIT_ADDRESS} across ${plan.length} withdraws.`);
    console.log("To submit, the PROVER SEAM must be wired first (see proveNoteWithdraw blocker). Re-run with --execute after that.");
    return;
  }

  // 5. EXECUTE — per note: prove → build → validate → persist → relay.
  const sdk = {
    buildTransact: (await import("../lib/shield/sdk/tx.ts")).buildTransact,
    encryptNote: (await import("../lib/shield/sdk/encrypt.ts")).encryptNote,
    encPublicKeyFromScalar: (await import("../lib/shield/sdk/encrypt.ts")).encPublicKeyFromScalar,
  };
  const { validateTransactCommands } = await import("../lib/shield/validate-commands.ts");
  const { toBase64 } = await import("@mysten/sui/utils");
  const zeroCoinSourceId = process.env.ZERO_COIN_SOURCE_ID;
  const relayer = (process.env.SHIELD_RELAYER_ADDRESS || "0x37949e572bbc9cd57b7817cf3d309c0fa1b5361e0bc7605f6feffc6b6fdb72af").toLowerCase();
  if (!zeroCoinSourceId) throw new Error("--execute needs ZERO_COIN_SOURCE_ID (a relayer-owned Coin<USDsui> to split the zero deposit-coin from)");
  process.env.SHIELD_PKG ||= PKG;
  process.env.SHIELD_RELAYER_ADDRESS ||= relayer;

  const done = existsSync(ART) ? JSON.parse(readFileSync(ART, "utf8")) : { swept: [] };
  for (const p of plan) {
    if (done.swept.some((s) => s.leafIndex === p.leafIndex && !s.pending)) { console.log(`  leaf #${p.leafIndex} already swept, skip`); continue; }
    const note = unspent.find((n) => n.leafIndex === p.leafIndex);
    const proof = proveNoteWithdraw(
      { spendingKey: keypair.spendingKey.toString(), amountMicros: p.amountMicros, blinding: note.blinding.toString(), commitment: note.commitment.toString(), leafIndex: p.leafIndex },
      leavesDec
    );
    const tx = await buildWithdrawPtb(sdk, proof, note, relayer, zeroCoinSourceId);
    validateTransactCommands(await tx.toJSON(), { exitAddress: EXIT_ADDRESS });
    tx.addBuildPlugin(jsonRpcResolutionPlugin());
    const txBytes = toBase64(await tx.build({ onlyTransactionKind: true }));
    // Crash-safety: persist proof + intent BEFORE submit so a crash can resume.
    done.swept.push({ leafIndex: p.leafIndex, amountMicros: p.amountMicros, proof, pending: true });
    writeFileSync(ART, JSON.stringify(done), { mode: 0o600 });
    const res = await fetch(`${API}/api/shield/relay`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ txBytes, exitAddress: EXIT_ADDRESS }),
    });
    const j = await res.json();
    if (!res.ok || !j.digest) throw new Error(`relay failed leaf ${p.leafIndex}: ${j.error ?? res.status}`);
    done.swept = done.swept.map((s) => (s.leafIndex === p.leafIndex ? { ...s, pending: false, digest: j.digest } : s));
    writeFileSync(ART, JSON.stringify(done), { mode: 0o600 });
    console.log(`  ✓ leaf #${p.leafIndex} swept — ${j.digest}`);
  }
  console.log(`\n=== SWEEP COMPLETE — $${(Number(totalMicros) / 1e6).toFixed(2)} to ${EXIT_ADDRESS} ===`);
}

const BN254 = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
function BN254_NEG(x) { return (BN254 - (x % BN254)) % BN254; }

main().catch((e) => { console.error("\nERROR:", e.message); process.exit(1); });
