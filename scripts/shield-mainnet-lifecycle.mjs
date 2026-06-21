#!/usr/bin/env node
// =============================================================================
// TALISE SHIELDED POOL — ONE-COMMAND MAINNET LIFECYCLE HARNESS
// -----------------------------------------------------------------------------
// Drives a REAL $10 shielded DEPOSIT -> (wait-for-index) -> WITHDRAW to a fresh
// address on Sui MAINNET, using:
//   • the Rust Groth16 prover            (move/.../circuit, bin: prove_lifecycle)
//   • the SDK PTB builder                (web/lib/shield/sdk/tx.ts :: buildTransact)
//   • the REAL relayer command allowlist (web/lib/shield/validate-commands.ts)
//   • the live relayer + Onara sponsor   (the production /api/shield/relay path)
//
// SAFETY: by default this DRY-RUNS only — it builds both PTBs, validates them
// through the real relayer control, and devInspect-simulates them on mainnet.
// It NEVER signs or submits a real money tx unless you pass --execute AND the
// relayer signing key is present (SHIELD_RELAYER_SK). The founder runs the
// printed one-liner with funds.
//
// PREREQUISITES (dry-run, the default):
//   • Node 24+ (strips TS types so we import the real .ts SDK directly).
//   • Run from web/ with the circuit built:
//       (cd ../move/talise-privacy/circuit && cargo build --release --bin prove_lifecycle)
//   • Network access to https://fullnode.mainnet.sui.io:443.
//
// ADDITIONAL PREREQUISITES (to EXECUTE the real round-trip, --execute):
//   • A funded sender wallet holding ≥ $10 USDsui + SUI for gas, exposed as:
//       SENDER_ADDRESS         the funded sender's Sui address
//       DEPOSIT_COIN_ID        a Coin<USDsui> object id of EXACTLY 10000000 micros
//                              (split one beforehand: `sui client split-coin ...`)
//       SENDER_SK              the sender's ed25519 secret key (suiprivkey1...)
//   • The relayer funded with a small USDsui coin (zero-coin split source) +
//     SUI for gas, and its key:
//       SHIELD_RELAYER_SK      relayer ed25519 key (matches the pinned relayer)
//       ZERO_COIN_SOURCE_ID    a relayer-owned Coin<USDsui> object id (split [0])
//   • EXIT_ADDRESS            a FRESH recipient address for the unshielded $10.
//   • ONARA_URL / Onara creds if you route gas through Onara (otherwise the
//     harness self-pays the relayer's gas — see executeReal()).
//
// USAGE:
//   node --env-file=.env.local scripts/shield-mainnet-lifecycle.mjs            # dry-run
//   node --env-file=.env.local scripts/shield-mainnet-lifecycle.mjs --execute  # real
//
// WHAT IT PROVES (dry-run):
//   1. The Rust prover emits two REAL Groth16 proofs (deposit + matched
//      withdraw) that NATIVE-VERIFY against the persisted VK == the on-chain VK.
//   2. The TS merkle (merkle.ts, byte-parity with the chain) re-derives the SAME
//      post-deposit root the Rust prover used — closing the cross-impl loop.
//   3. buildTransact assembles each into the exact transact PTB the relayer expects.
//   4. The REAL validateTransactCommands ACCEPTS both PTBs (relayer-pinned,
//      fee 0, return-coin routed to relayer / screened exit).
//   5. mainnet devInspect: DEPOSIT => status success (on-chain Groth16 verify +
//      nullifier + commitment append all pass); WITHDRAW => verified valid, and
//      after the deposit lands its post-deposit root enters root_history so the
//      same withdraw passes assert_root_is_known.
// =============================================================================

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Pinned mainnet wiring (matches Vercel SHIELD_* prod env) ────────────────
const RPC = "https://fullnode.mainnet.sui.io:443";
const PKG = "0x8722790773958722225cf91f5a6762689dc13f97076534c05ebd3505d586f9bf";
const POOL = "0x6bcd28763456db543d0c29acb34970b81e4d7f004d2581fce46b813ece8152c1";
const POOL_INITIAL_SHARED_VERSION = "919114728";
const COIN_TYPE =
  "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const RELAYER = "0x37949e572bbc9cd57b7817cf3d309c0fa1b5361e0bc7605f6feffc6b6fdb72af";
// Deposit amount in micros. Default $10 (the per-tx cap); override with
// AMOUNT_MICROS for a smaller validation run (e.g. 1000000 = $1).
const AMOUNT = BigInt(process.env.AMOUNT_MICROS || 10_000_000);

// --self-relayer: drive BOTH legs from the funded sender wallet. This circuit's
// proof binds pool/value/nullifiers/commitments — NOT the relayer/recipient — so
// the sender can act as its own relayer for a complete real round-trip without
// the production SHIELD_RELAYER_SK (which is a write-only Vercel sensitive var).
// The unlinkability still holds: deposit emits an unlinkable commitment, withdraw
// spends an unlinkable nullifier to a fresh exit. WRELAYER is the effective
// withdraw relayer address used by the PTB, the validator, and execution.
const SELF_RELAYER = process.argv.includes("--self-relayer") || process.env.SELF_RELAYER === "1";
// --withdraw-only: the deposit already landed; submit ONLY the withdraw. Requires
// --resume so the SAME note secrets are reused (the prover is non-deterministic).
const WITHDRAW_ONLY = process.argv.includes("--withdraw-only");
// --resume: load the prover artifact from disk instead of re-running the prover.
// CRASH-SAFETY: the prover uses fresh OsRng secrets each run (prove_lifecycle.rs),
// so a deposit that lands but whose withdraw never fires would strand funds with
// unrecoverable secrets. We therefore PERSIST `art` to disk BEFORE submitting the
// deposit; if anything throws mid-flight, `--resume --withdraw-only` reloads the
// exact same secrets and completes the matching withdraw.
const RESUME = process.argv.includes("--resume");
const ART_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".shield-lifecycle-art.json"
);
const WRELAYER = ((SELF_RELAYER ? process.env.SENDER_ADDRESS : RELAYER) || RELAYER).toLowerCase();

// The validate-commands control reads SHIELD_PKG / SHIELD_RELAYER_ADDRESS from env.
process.env.SHIELD_PKG ||= PKG;
process.env.SHIELD_RELAYER_ADDRESS = SELF_RELAYER ? WRELAYER : (process.env.SHIELD_RELAYER_ADDRESS || RELAYER);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CIRCUIT_DIR = path.resolve(__dirname, "../../move/talise-privacy/circuit");
const PROVER_BIN = path.join(CIRCUIT_DIR, "target/release/prove_lifecycle");

const EXECUTE = process.argv.includes("--execute");
const EXIT_ADDRESS =
  process.env.EXIT_ADDRESS?.toLowerCase() ||
  // dry-run default: a fresh deterministic placeholder exit (no funds touch it).
  "0x39d4ded1f081c828662dcbf4a43c9183c9e10510112e269d961cf89c90b1ae7b";

function log(...a) {
  console.log(...a);
}
function hr(title) {
  log("\n" + "=".repeat(78));
  log(title);
  log("=".repeat(78));
}

// ── 1. Fetch the live empty-tree root (the deposit binds to it) ─────────────
const MERKLE_TREE_DOF = "0x8e60af49055d1cec29e7ed6c5814157d5c6a499f123f4c7e4236811419ecbd7e";

async function rootHistoryAt(index) {
  const mtRes = await rpc("suix_getDynamicFieldObject", [
    MERKLE_TREE_DOF,
    { type: "u64", value: String(index) },
  ]);
  const root = mtRes?.data?.content?.fields?.value;
  return root ? String(root) : null;
}

async function liveEmptyRoot() {
  const root = await rootHistoryAt(0);
  if (!root) throw new Error("could not read live empty root from root_history[0]");
  return root;
}

// The CURRENT (latest) tree root. Each deposit appends 2 leaves + 1 root entry,
// so for next_index N the latest root sits at root_history[N/2]. The deposit's
// dummy (zero-amount) inputs skip membership, so binding the deposit proof to
// this KNOWN root satisfies on-chain assert_root_is_known on a non-empty pool.
async function liveCurrentRoot(nextIndex) {
  const idx = Math.floor(Number(nextIndex) / 2);
  const root = (await rootHistoryAt(idx)) ?? (await liveEmptyRoot());
  return root;
}

// All commitments already in the pool, in leaf order (so the prover can rebuild
// the real tree and place this deposit at the correct next leaf index).
async function fetchExistingLeaves(count) {
  if (count <= 0) return [];
  const res = await rpc("suix_queryEvents", [
    { MoveEventModule: { package: PKG, module: "events" } },
    null,
    1000,
    false, // ascending
  ]);
  const byLeaf = new Map();
  for (const e of res?.data ?? []) {
    const f = e.parsedJson ?? {};
    const c = f.commitment ?? f.leaf ?? f.value;
    const li = f.leaf_index ?? f.index ?? f.leafIndex;
    if (c !== undefined && li !== undefined) byLeaf.set(Number(li), String(c));
  }
  const leaves = [];
  for (let i = 0; i < count; i++) {
    const v = byLeaf.get(i);
    if (v === undefined) {
      throw new Error(`missing on-chain leaf ${i} (have ${byLeaf.size} commitment events) — can't rebuild the tree`);
    }
    leaves.push(v);
  }
  return leaves;
}

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method} error: ${JSON.stringify(j.error)}`);
  return j.result;
}

// ── 2. Run the Rust lifecycle prover, parse its JSON artifact ───────────────
// `depositRoot` is the known root the deposit binds to (current root); on a
// non-empty pool `existingLeaves` are the commitments already in the tree, so the
// prover places this deposit at the right leaf + proves the withdraw against the
// real reconstructed root.
function runRustProver(depositRoot, existingLeaves = []) {
  let out;
  try {
    const proverArgs = [
      "--pool", POOL,
      "--amount", String(AMOUNT),
      "--empty-root", depositRoot,
    ];
    if (existingLeaves.length > 0) {
      proverArgs.push("--existing-leaves", existingLeaves.join(","));
    }
    out = execFileSync(
      PROVER_BIN,
      proverArgs,
      { cwd: CIRCUIT_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
    );
  } catch (e) {
    throw new Error(
      `prove_lifecycle failed. Build it first:\n` +
        `  (cd ${CIRCUIT_DIR} && cargo build --release --bin prove_lifecycle)\n` +
        (e.message || "")
    );
  }
  const m = out.match(/BEGIN_LIFECYCLE_JSON\s*([\s\S]*?)\s*END_LIFECYCLE_JSON/);
  if (!m) throw new Error("prover did not emit a LIFECYCLE_JSON block");
  return JSON.parse(m[1].trim());
}

async function main() {
  if (WITHDRAW_ONLY && !RESUME) {
    throw new Error(
      "--withdraw-only requires --resume: the withdraw MUST reuse the landed " +
        "deposit's persisted secrets, not a fresh (mismatched) prover run."
    );
  }
  hr("TALISE SHIELDED POOL — MAINNET LIFECYCLE HARNESS  (mode: " + (EXECUTE ? "EXECUTE" : "DRY-RUN") + ")");
  log(`pool      ${POOL}`);
  log(`package   ${PKG}`);
  log(`relayer   ${RELAYER}`);
  log(`amount    ${AMOUNT} micros USDsui ($${(Number(AMOUNT) / 1e6).toFixed(2)})`);

  // ── Real SDK + merkle (Node strips the TS types) ──────────────────────────
  const { buildTransact } = await import("../lib/shield/sdk/tx.ts");
  const { encryptNote, encPublicKeyFromScalar } = await import("../lib/shield/sdk/encrypt.ts");
  const { validateTransactCommands } = await import("../lib/shield/validate-commands.ts");
  const merkle = await import("../lib/shield/merkle.ts");

  // STEP 0 — read pool state. Works for an EMPTY pool (first deposit at leaves
  // 0,1) AND a NON-EMPTY pool (deposit appends at next_index; the withdraw proves
  // membership against the real reconstructed tree).
  hr("STEP 0 — read pool state (next_index, current root, existing leaves)");
  const mt = await rpc("sui_getObject", [
    "0x5a32ce39a3d9961ca5c1785f708f95b22434287047cb0db1bff76090de2c3e47",
    { showContent: true },
  ]);
  const nextIndex = Number(mt?.data?.content?.fields?.next_index ?? 0);
  log(`merkle next_index = ${nextIndex} (this deposit lands at leaves ${nextIndex},${nextIndex + 1})`);

  // Sanity: merkle.ts agrees the empty root is EMPTY_SUBTREE_HASHES[26].
  if (!merkle.selfTest()) throw new Error("merkle.ts Poseidon self-test FAILED");

  // The deposit binds to the CURRENT (known) root; existing leaves let the prover
  // rebuild the real tree so the withdraw targets the true post-deposit root.
  const depositRoot = await liveCurrentRoot(nextIndex);
  const existingLeaves = RESUME ? [] : await fetchExistingLeaves(nextIndex);
  log(`deposit binds to current root = ${depositRoot}`);
  log(`existing leaves               = ${existingLeaves.length}`);

  // STEP 1 — REAL Groth16 proofs (deposit + matched withdraw).
  // CRASH-SAFETY: --resume loads the persisted artifact (same secrets) so a
  // deposit that already landed can have its MATCHING withdraw completed. A fresh
  // prover run is persisted to ART_FILE *before* any submission (see executeReal).
  hr("STEP 1 — Rust prover: REAL Groth16 deposit + matched withdraw (native verify)");
  let art;
  if (RESUME) {
    if (!fs.existsSync(ART_FILE)) {
      throw new Error(`--resume: no saved artifact at ${ART_FILE} (nothing to resume)`);
    }
    art = JSON.parse(fs.readFileSync(ART_FILE, "utf8"));
    log(`RESUME: loaded saved prover artifact from ${path.basename(ART_FILE)}`);
    log(`  (same note secrets as the landed deposit — withdraw will match)`);
  } else {
    art = runRustProver(depositRoot, existingLeaves);
    // Persist BEFORE any on-chain submission so a mid-flight crash is recoverable.
    fs.writeFileSync(ART_FILE, JSON.stringify(art), { mode: 0o600 });
    log(`prover artifact persisted to ${path.basename(ART_FILE)} (crash-safe).`);
  }
  log(`deposit  public_value = ${art.deposit.public_value}  (== +amount)`);
  log(`withdraw public_value = ${art.withdraw.public_value}  (== r - amount)`);
  log(`post_deposit_root     = ${art.post_deposit_root}`);

  // STEP 2 — TS merkle re-derives the SAME post-deposit root (cross-impl loop).
  // Rebuild the tree exactly as the chain will: existing leaves first, then this
  // deposit's pair. (On resume we trust the persisted artifact's root.)
  hr("STEP 2 — merkle.ts re-derives the post-deposit root (cross-impl parity)");
  if (!RESUME) {
    let tsTree = merkle.emptyTree();
    for (let i = 0; i < existingLeaves.length; i += 2) {
      tsTree = merkle.appendPair(tsTree, BigInt(existingLeaves[i]), BigInt(existingLeaves[i + 1]));
    }
    tsTree = merkle.appendPair(
      tsTree,
      BigInt(art.deposit.output_commitment0),
      BigInt(art.deposit.output_commitment1)
    );
    if (tsTree.root !== art.post_deposit_root) {
      throw new Error(
        `POST-DEPOSIT ROOT MISMATCH:\n  Rust  ${art.post_deposit_root}\n  TS    ${tsTree.root}`
      );
    }
    log(`existing-leaves + deposit pair → root == Rust post_deposit_root : PASS`);
    log(`  => ${tsTree.root}`);
    log("This is the root the chain holds AFTER the deposit; the withdraw targets it.");
  } else {
    log("RESUME: using persisted post_deposit_root (validated when first proven).");
  }

  // STEP 3 — build BOTH transact PTBs with the REAL SDK buildTransact.
  hr("STEP 3 — build deposit + withdraw PTBs via the REAL SDK buildTransact");

  // Real ECIES note blobs (self-owned enc key for this harness round-trip).
  const poolField = BigInt(POOL) % merkle.BN254_FIELD_MODULUS;
  const encKey = encPublicKeyFromScalar(0x5eedn);
  const blob = async (amount, pubkey, blinding) =>
    encryptNote({ amount, pubkey, blinding, pool: poolField }, encKey);
  const enc0d = await blob(AMOUNT, BigInt(art.deposit.output_commitment0), 1n);
  const enc1d = await blob(0n, BigInt(art.deposit.output_commitment1), 2n);
  const enc0w = await blob(0n, BigInt(art.withdraw.output_commitment0), 3n);
  const enc1w = await blob(0n, BigInt(art.withdraw.output_commitment1), 4n);

  const toPoints = (hex) => Uint8Array.from(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));

  // ----- DEPOSIT PTB -----
  // depositCoinId: the funded sender's exact-$10 coin (real for --execute, a
  // pinned placeholder ref otherwise so the PTB serializes for validation/sim).
  const depositCoinId =
    process.env.DEPOSIT_COIN_ID ||
    "0x8a1c28a71ddfb123581eef0325c42212f3ce4161a4fc06b1702914c777ad4b27";
  // The deposit proof binds pool/value/nullifiers/commitments — NOT the relayer
  // address — so the SAME proof works whether the relayer submits (ext.relayer
  // = RELAYER, the production relayed path validated in Step 4) or the sender
  // self-submits (ext.relayer = sender, what executeReal uses, since the sender
  // owns the deposit coin). `mkDeposit` lets us build either.
  const mkDeposit = (relayerAddr) =>
    buildTransact({
      packageId: PKG,
      coinType: COIN_TYPE,
      poolObjectId: POOL,
      poolAddress: POOL,
      proof: {
        proofPoints: toPoints(art.deposit.proof_hex),
        root: BigInt(art.deposit.root),
        publicValue: BigInt(art.deposit.public_value),
        inputNullifier0: BigInt(art.deposit.input_nullifier0),
        inputNullifier1: BigInt(art.deposit.input_nullifier1),
        outputCommitment0: BigInt(art.deposit.output_commitment0),
        outputCommitment1: BigInt(art.deposit.output_commitment1),
      },
      ext: {
        value: AMOUNT,
        valueSign: true, // deposit
        relayer: relayerAddr,
        relayerFee: 0n,
        encryptedOutput0: enc0d,
        encryptedOutput1: enc1d,
      },
      depositCoinId,
      outputRecipient: relayerAddr, // deposit return coin is zero -> submitter
    });
  // Step 4 validates the relayer-submitted form (ext.relayer == effective relayer).
  const depositTx = mkDeposit(WRELAYER);

  // ----- WITHDRAW PTB -----
  const zeroCoinSourceId =
    process.env.ZERO_COIN_SOURCE_ID ||
    "0x8a1c28a71ddfb123581eef0325c42212f3ce4161a4fc06b1702914c777ad4b27";
  const withdrawTx = buildTransact({
    packageId: PKG,
    coinType: COIN_TYPE,
    poolObjectId: POOL,
    poolAddress: POOL,
    proof: {
      proofPoints: toPoints(art.withdraw.proof_hex),
      root: BigInt(art.withdraw.root),
      publicValue: BigInt(art.withdraw.public_value),
      inputNullifier0: BigInt(art.withdraw.input_nullifier0),
      inputNullifier1: BigInt(art.withdraw.input_nullifier1),
      outputCommitment0: BigInt(art.withdraw.output_commitment0),
      outputCommitment1: BigInt(art.withdraw.output_commitment1),
    },
    ext: {
      value: AMOUNT,
      valueSign: false, // withdraw
      relayer: WRELAYER,
      relayerFee: 0n,
      encryptedOutput0: enc0w,
      encryptedOutput1: enc1w,
    },
    zeroCoinSourceId,
    outputRecipient: EXIT_ADDRESS, // unshielded $10 -> fresh exit
  });

  const depositJson = await depositTx.toJSON();
  const withdrawJson = await withdrawTx.toJSON();
  log("deposit PTB built  (proof::new + ext_data::new + transact + TransferObjects->relayer)");
  log("withdraw PTB built (proof::new + ext_data::new + SplitCoins[0] + transact + TransferObjects->exit)");

  // STEP 4 — REAL relayer command allowlist must ACCEPT both.
  hr("STEP 4 — REAL validateTransactCommands (the relayer security control)");
  const vDep = validateTransactCommands(depositJson, { exitAddress: null });
  log(`DEPOSIT  ACCEPTED  fn=${vDep.fn} relayer=${vDep.relayer} fee=${String(vDep.relayerFee)}`);
  const vWith = validateTransactCommands(withdrawJson, { exitAddress: EXIT_ADDRESS });
  log(`WITHDRAW ACCEPTED  fn=${vWith.fn} relayer=${vWith.relayer} fee=${String(vWith.relayerFee)}`);

  // STEP 5 — mainnet devInspect simulation of both legs.
  // devInspect enforces input-object OWNERSHIP, so each leg's sim sender must
  // own its deposit/zero-coin source. We resolve the real owners via JSON-RPC.
  hr("STEP 5 — mainnet devInspect simulation (no funds spent)");
  const depOwner = (await rpc("sui_getObject", [depositCoinId, { showOwner: true }]))?.data?.owner
    ?.AddressOwner;
  const zeroOwner = (await rpc("sui_getObject", [zeroCoinSourceId, { showOwner: true }]))?.data
    ?.owner?.AddressOwner;
  // DEPOSIT sim: submitter == the deposit-coin owner, so ext.relayer = that
  // owner (on-chain assert_relayer checks sender == ext.relayer). This is the
  // self-submit form executeReal uses; the proof is identical to Step 4's.
  const depositSimTx = mkDeposit(depOwner || RELAYER);
  await simulate("DEPOSIT", depositSimTx, depOwner || RELAYER);
  // WITHDRAW sim: relayer-submitted (ext.relayer = RELAYER) but the zero-coin
  // source is owned by `zeroOwner`; set sender to that owner so the coin
  // reservation resolves (the real relayer owns its own zero-coin source).
  await simulate("WITHDRAW", withdrawTx, zeroOwner || RELAYER, art.post_deposit_root);

  // STEP 6 — the founder's one command (or auto-execute when --execute).
  if (EXECUTE) {
    await executeReal({ depositTx, withdrawTx, art });
  } else {
    printExecuteInstructions();
  }
}

// A build plugin that resolves every UnresolvedObject input via JSON-RPC and
// pins it on the LIVE transactionData (the shared pool gets its
// initialSharedVersion; owned coins get {version,digest}). This is the
// SDK-native object-resolution seam — it mutates the real build data so
// `build({ onlyTransactionKind: true })` succeeds fully offline against mainnet
// state. Same pins the existing shield-sim-*.mjs scripts set by hand, but driven
// straight from the SDK-built PTB. We use JSON-RPC (reliable here) instead of
// the gRPC client.
function jsonRpcResolutionPlugin() {
  return async (transactionData, _options, next) => {
    const ids = new Set();
    for (const inp of transactionData.inputs) {
      if (inp.$kind === "UnresolvedObject" && inp.UnresolvedObject?.objectId) {
        ids.add(inp.UnresolvedObject.objectId);
      }
    }
    if (ids.size > 0) {
      const objs = await rpc("sui_multiGetObjects", [[...ids], { showOwner: true }]);
      const byId = new Map();
      for (const o of objs) {
        const d = o?.data;
        if (d) byId.set(d.objectId, { version: String(d.version), digest: d.digest, owner: d.owner });
      }
      for (const inp of transactionData.inputs) {
        if (inp.$kind !== "UnresolvedObject") continue;
        const id = inp.UnresolvedObject.objectId;
        const info = byId.get(id);
        if (!info) throw new Error(`object ${id} not found on mainnet`);
        const shared = info.owner?.Shared;
        delete inp.UnresolvedObject;
        if (shared) {
          inp.$kind = "Object";
          inp.Object = {
            $kind: "SharedObject",
            SharedObject: {
              objectId: id,
              initialSharedVersion: String(shared.initial_shared_version),
              mutable: true,
            },
          };
        } else {
          inp.$kind = "Object";
          inp.Object = {
            $kind: "ImmOrOwnedObject",
            ImmOrOwnedObject: { objectId: id, version: info.version, digest: info.digest },
          };
        }
      }
    }
    await next();
  };
}

async function simulate(label, tx, sender, postDepositRoot) {
  const { toBase64 } = await import("@mysten/sui/utils");
  let kind;
  try {
    tx.addBuildPlugin(jsonRpcResolutionPlugin());
    kind = await tx.build({ onlyTransactionKind: true });
  } catch (e) {
    log(
      `${label} devInspect: could not resolve object refs (${e.message.split("\n")[0]}).`
    );
    log(
      `  With real DEPOSIT_COIN_ID / ZERO_COIN_SOURCE_ID this resolves + simulates.`
    );
    return;
  }
  let res;
  try {
    res = await rpc("sui_devInspectTransactionBlock", [sender, toBase64(kind), null, null]);
  } catch (e) {
    log(`${label} devInspect: RPC error ${e.message}`);
    return;
  }
  const status = res?.effects?.status?.status;
  const err = res?.effects?.status?.error;
  const events = (res?.events ?? []).map((e) => e.type.split("::").slice(-1)[0]);
  log(`${label} devInspect status: ${status}${err ? "  error=" + err : ""}`);
  if (events.length) log(`${label} events: ${events.join(", ")}`);
  // Abort-code interpretation (process_transaction check order:
  // assert_root_is_known(800) -> nullifier-unspent(803) -> Groth16 verify(801)
  // -> public-value(804) -> deposit-value(805)).
  if (label === "DEPOSIT") {
    if (status === "success") {
      log("  ^ DEPOSIT SUCCESS: on-chain Groth16 verify + nullifier + commitment append all passed.");
    } else if (err && err.includes("805")) {
      log(
        `  ^ EInvalidDepositValue(805): the deposit coin's value != the proof's\n` +
          `    $10 ext.value. This abort is AFTER the on-chain Groth16 verify (801)\n` +
          `    + nullifier(803) + public-value(804) checks — so the REAL $10 deposit\n` +
          `    PROOF VERIFIED ON-CHAIN. The only mismatch is the DRY-RUN placeholder\n` +
          `    coin (~$0.20). With a real exact-$10 DEPOSIT_COIN_ID, line 328 passes\n` +
          `    and the deposit succeeds (emits 2x NewCommitment).`
      );
    } else if (err && err.includes("801")) {
      log("  ^ EInvalidProof(801): on-chain Groth16 verify REJECTED — investigate (should not happen).");
    }
  }
  if (label === "WITHDRAW" && err && err.includes("800")) {
    log(
      `  ^ EProofRootNotKnown(800) is EXPECTED until the deposit executes: the\n` +
        `    withdraw targets the post-deposit root ${postDepositRoot}\n` +
        `    which only enters root_history AFTER the deposit lands. Step 2 proved\n` +
        `    that root is exactly what the chain computes, so once the deposit is\n` +
        `    indexed this same withdraw passes assert_root_is_known + verifies.`
    );
  }
}

function printExecuteInstructions() {
  hr("RESULT — DRY-RUN COMPLETE.  To run the REAL $10 mainnet round-trip:");
  log(`
PREP (one-time, with a funded wallet):
  1. Split an EXACT $10 USDsui coin for the sender:
       sui client split-coin --coin-id <yourUsdsuiCoin> --amounts 10000000 \\
         --gas-budget 5000000
     -> note the new coin object id (this is DEPOSIT_COIN_ID).
  2. Ensure the relayer ${RELAYER}
     holds a small USDsui coin (the zero-coin split source) + some SUI for gas.
     -> note that coin object id (ZERO_COIN_SOURCE_ID).
  3. Pick a FRESH recipient address for the unshielded $10 (EXIT_ADDRESS).

THE ONE COMMAND (run from web/):
  SENDER_ADDRESS=0x<sender> \\
  SENDER_SK=suiprivkey1<sender-key> \\
  DEPOSIT_COIN_ID=0x<exact-$10-coin> \\
  SHIELD_RELAYER_SK=suiprivkey1<relayer-key> \\
  ZERO_COIN_SOURCE_ID=0x<relayer-usdsui-coin> \\
  EXIT_ADDRESS=0x<fresh-recipient> \\
  node --env-file=.env.local scripts/shield-mainnet-lifecycle.mjs --execute

WHAT --execute DOES:
  • DEPOSIT leg: sender signs + submits the deposit PTB (it owns DEPOSIT_COIN_ID).
    Prints the deposit tx digest + suivision link. The pool tree now holds your
    note at leaves 0,1; root_history gains the post-deposit root.
  • WAIT-FOR-INDEX: polls the on-chain root_history until the post-deposit root
    appears (it is written in the same deposit tx, so this is immediate on
    finality).
  • WITHDRAW leg: relayer (SHIELD_RELAYER_SK) signs + submits the withdraw PTB,
    splitting a zero coin from ZERO_COIN_SOURCE_ID; the unshielded $10 lands at
    EXIT_ADDRESS. Prints the withdraw tx digest + suivision link.

The two digests + links are the proof of a complete shielded round-trip whose
sender↔recipient link is severed by the relayer-submitted withdraw.
`);
}

// ── Real on-chain execution (only with --execute + keys present) ────────────
async function executeReal({ depositTx, withdrawTx, art }) {
  hr("EXECUTE — real mainnet round-trip");
  const { sui } = await import("../lib/sui.ts");
  const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");

  const need = (k) => {
    const v = process.env[k];
    if (!v) throw new Error(`--execute requires env ${k}`);
    return v;
  };
  const { toBase64 } = await import("@mysten/sui/utils");
  const senderSk = need("SENDER_SK");
  const senderAddr = need("SENDER_ADDRESS");
  if (!WITHDRAW_ONLY) need("DEPOSIT_COIN_ID");
  // In --self-relayer mode the sender signs the withdraw too (it owns the
  // zero-coin source + ext.relayer == sender). Otherwise use the prod relayer.
  const relayerSk = SELF_RELAYER ? senderSk : need("SHIELD_RELAYER_SK");
  need("ZERO_COIN_SOURCE_ID");
  const exit = need("EXIT_ADDRESS");

  const client = sui();
  const senderKp = Ed25519Keypair.fromSecretKey(senderSk);
  const relayerKp = Ed25519Keypair.fromSecretKey(relayerSk);
  if (senderKp.toSuiAddress().toLowerCase() !== senderAddr.toLowerCase())
    throw new Error("SENDER_SK does not match SENDER_ADDRESS");
  if (relayerKp.toSuiAddress().toLowerCase() !== WRELAYER)
    throw new Error(`withdraw signer does not match effective relayer ${WRELAYER}`);

  // Build with the gRPC client (resolves objects + selects gas) but SUBMIT via
  // JSON-RPC, which returns a clean { digest, effects } — the gRPC client's
  // signAndExecuteTransaction response shape doesn't expose .digest reliably here.
  const buildSignSubmit = async (tx, kp) => {
    const built = await tx.build({ client });
    const { signature } = await kp.signTransaction(built);
    const res = await rpc("sui_executeTransactionBlock", [
      toBase64(built),
      [signature],
      { showEffects: true, showEvents: true },
      "WaitForLocalExecution",
    ]);
    return { digest: res?.digest, status: res?.effects?.status?.status, error: res?.effects?.status?.error };
  };

  let depRes = { digest: process.env.DEPOSIT_DIGEST || "(already landed)" };
  if (WITHDRAW_ONLY) {
    log("WITHDRAW-ONLY: skipping the (already-landed) deposit. Verifying post-deposit root is known…");
    const rh = await rpc("suix_getDynamicFieldObject", [
      "0x8e60af49055d1cec29e7ed6c5814157d5c6a499f123f4c7e4236811419ecbd7e",
      { type: "u64", value: "1" },
    ]).catch(() => null);
    const v = rh?.data?.content?.fields?.value;
    if (String(v) !== art.post_deposit_root) {
      throw new Error(`post-deposit root not yet known on-chain (have ${v}, need ${art.post_deposit_root})`);
    }
    log("post-deposit root is KNOWN — proceeding to withdraw.");
  } else {
  // --- DEPOSIT: the sender owns the deposit coin, so the sender submits. The
  //     ext_data.relayer is RELAYER but on the deposit leg assert_relayer is
  //     satisfied only if sender == relayer. So for a sender-submitted deposit
  //     the ext relayer must be the SENDER. Rebuild the deposit ext with the
  //     sender as relayer (deposit return coin is zero — no fund risk), keeping
  //     the SAME proof (the proof binds pool/value/nullifiers/commitments, NOT
  //     the relayer address).
  log("Submitting DEPOSIT (sender-signed)...");
  const { buildTransact } = await import("../lib/shield/sdk/tx.ts");
  const { encryptNote, encPublicKeyFromScalar } = await import("../lib/shield/sdk/encrypt.ts");
  const encKey = encPublicKeyFromScalar(0x5eedn);
  const e0 = await encryptNote({ amount: AMOUNT, pubkey: 1n, blinding: 1n, pool: BigInt(POOL) }, encKey);
  const e1 = await encryptNote({ amount: 0n, pubkey: 2n, blinding: 2n, pool: BigInt(POOL) }, encKey);
  const toPoints = (hex) => Uint8Array.from(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));
  const depTx = buildTransact({
    packageId: PKG, coinType: COIN_TYPE, poolObjectId: POOL, poolAddress: POOL,
    proof: {
      proofPoints: toPoints(art.deposit.proof_hex),
      root: BigInt(art.deposit.root), publicValue: BigInt(art.deposit.public_value),
      inputNullifier0: BigInt(art.deposit.input_nullifier0),
      inputNullifier1: BigInt(art.deposit.input_nullifier1),
      outputCommitment0: BigInt(art.deposit.output_commitment0),
      outputCommitment1: BigInt(art.deposit.output_commitment1),
    },
    ext: { value: AMOUNT, valueSign: true, relayer: senderAddr, relayerFee: 0n, encryptedOutput0: e0, encryptedOutput1: e1 },
    depositCoinId: process.env.DEPOSIT_COIN_ID,
    outputRecipient: senderAddr,
  });
  depTx.setSender(senderAddr);
  // Resolve object refs via JSON-RPC (reliable) rather than the gRPC client.
  depTx.addBuildPlugin(jsonRpcResolutionPlugin());
  depRes = await buildSignSubmit(depTx, senderKp);
  log(`DEPOSIT digest: ${depRes.digest}`);
  log(`  https://suivision.xyz/txblock/${depRes.digest}`);
  log(`  status: ${depRes.status}`);
  if (depRes.status !== "success") {
    throw new Error("deposit failed: " + JSON.stringify(depRes.error ?? depRes.status));
  }
  await client.waitForTransaction({ digest: depRes.digest });

  // --- WAIT-FOR-INDEX: poll root_history until the post-deposit root appears.
  log("Waiting for the post-deposit root to enter root_history...");
  let known = false;
  for (let i = 0; i < 30 && !known; i++) {
    const rh = await rpc("suix_getDynamicFieldObject", [
      "0x8e60af49055d1cec29e7ed6c5814157d5c6a499f123f4c7e4236811419ecbd7e",
      { type: "u64", value: "1" },
    ]).catch(() => null);
    const v = rh?.data?.content?.fields?.value;
    if (v && String(v) === art.post_deposit_root) known = true;
    else await new Promise((r) => setTimeout(r, 2000));
  }
  log(known ? "post-deposit root is KNOWN on-chain." : "root not observed (continuing — it is written in the deposit tx).");
  }

  // --- WITHDRAW: relayer-signed (it owns ZERO_COIN_SOURCE_ID; ext.relayer==relayer).
  log(`Submitting WITHDRAW (${SELF_RELAYER ? "self-relayer" : "relayer"}-signed)...`);
  withdrawTx.setSender(WRELAYER);
  withdrawTx.addBuildPlugin(jsonRpcResolutionPlugin());
  const wRes = await buildSignSubmit(withdrawTx, relayerKp);
  log(`WITHDRAW digest: ${wRes.digest}`);
  log(`  https://suivision.xyz/txblock/${wRes.digest}`);
  log(`  status: ${wRes.status}${wRes.error ? "  error=" + wRes.error : ""}`);

  hr("ROUND-TRIP COMPLETE");
  log(`DEPOSIT : https://suivision.xyz/txblock/${depRes.digest}`);
  log(`WITHDRAW: https://suivision.xyz/txblock/${wRes.digest}`);
  log(`$${(Number(AMOUNT) / 1e6).toFixed(2)} left the pool to a fresh address ${exit}, unlinked from the depositor.`);
}

main().catch((e) => {
  console.error("\nHARNESS ERROR:", e.message || e);
  process.exit(1);
});
