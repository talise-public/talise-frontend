/**
 * Talise shielded-pool SDK — END-TO-END FLOW ORCHESTRATION (Workstream C).
 *
 * This is the single surface the app calls to run a shielded operation. It ties
 * together every other SDK piece into one round-trip per op:
 *
 *   keys (deriveShieldKeypair)
 *     → witness assembly (this file — mirrors circuit/src/prover.rs exactly)
 *     → Merkle path  (POST /api/shield/merkle-path)
 *     → Groth16 prove (proveTransact → WASM worker, real entropy)
 *     → note encryption (encryptNote → P-256 ECIES, REAL)
 *     → transact PTB  (buildTransact → matches the deployed decoupled pool)
 *     → relay/sponsor  (POST /api/shield/relay → validate + Onara gas)
 *
 * Three entry points: {@link shieldDeposit}, {@link shieldTransfer},
 * {@link shieldWithdraw}. Each returns the spendable OUTPUT notes (so the caller
 * persists them for a future spend) plus the relayer's tx digest.
 *
 * ── WITNESS PARITY (the load-bearing invariant) ─────────────────────────────
 * The 2-in/2-out witness below is a line-for-line port of
 * `circuit/src/prover.rs::build_deposit_circuit_for_pool` (and the withdraw /
 * transfer bins): pubkey = Poseidon1(sk); commitment = Poseidon4(amount, pubkey,
 * blinding, pool); signature = Poseidon3(sk, commitment, pathIndex); nullifier =
 * Poseidon3(commitment, pathIndex, signature); public_amount = +value (deposit),
 * (r − value) (withdraw), 0 (transfer); hashed_secret = 0 (unsponsored path).
 *
 * CRYPTO STATUS:
 *   • Poseidon parity is VERIFIED (2026-06-17): `@mysten/sui/zklogin` poseidonHash
 *     == the circuit's `poseidon_opt` at arity 1/3/4 (keys.ts; known-answer gate
 *     circuit/tests/poseidon_parity.rs) and arity-2 == `sui::poseidon_bn254`
 *     on-chain (Phase-0 gate). So this JS witness assembler produces commitments
 *     and nullifiers the circuit accepts — browser-assembled proofs verify
 *     on-chain. The full lifecycle was also proven via the Rust prover.
 *   • Remaining trust assumption: the verifying key is a SINGLE-PARTY OsRng setup
 *     (constants.move). Not outsider-forgeable, but trustless mainnet at scale
 *     still needs the multi-party ceremony + external audit. The capped-pilot
 *     posture (small caps, operator-trust disclosed) is what rides on it.
 */

import { USDSUI_TYPE } from "@/lib/usdsui";
import {
  deriveShieldEncScalar,
  poseidon1,
  poseidonStub as poseidonN,
  BN254_SCALAR_FIELD,
  type ShieldKeypair,
} from "./keys";
import { randomField } from "./note";
import { encryptNote, encPublicKeyFromScalar, type RecipientEncKey } from "./encrypt";
import { proveTransact, buildTransact, type ProofInputs, type ExtDataInput } from "./tx";
import type { ProofInput } from "./prover";
import { scanNotes } from "./scan";

const r = BN254_SCALAR_FIELD;
const mod = (x: bigint) => ((x % r) + r) % r;
const dec = (x: bigint) => mod(x).toString();

// ── Poseidon arities (mirror circuit hash1/hash3/hash4) ─────────────────────
const hash1 = (a: bigint) => poseidon1(mod(a));
const hash3 = (a: bigint, b: bigint, c: bigint) => poseidonN([mod(a), mod(b), mod(c)]);
const hash4 = (a: bigint, b: bigint, c: bigint, d: bigint) =>
  poseidonN([mod(a), mod(b), mod(c), mod(d)]);

/** commitment = Poseidon4(amount, pubkey, blinding, pool). */
function commit(amount: bigint, pubkey: bigint, blinding: bigint, pool: bigint): bigint {
  return hash4(amount, pubkey, blinding, pool);
}
/** signature = Poseidon3(sk, commitment, pathIndex); nullifier = Poseidon3(commitment, pathIndex, signature). */
function nullifierFor(sk: bigint, commitment: bigint, pathIndex: bigint): bigint {
  const sig = hash3(sk, commitment, pathIndex);
  return hash3(commitment, pathIndex, sig);
}

// ── Note shapes used by the flow ────────────────────────────────────────────

/** An input note being spent — the secrets + its on-chain position. */
export type FlowInputNote = {
  /** Note spending key (the spend authority for this note). */
  privateKey: bigint;
  amount: bigint;
  blinding: bigint;
  /** Leaf index in the Merkle tree (also the nullifier path index). */
  leafIndex: number;
  /** The commitment as recorded on-chain (used to fetch the Merkle path). */
  commitment: bigint;
};

/** An output note produced by the op — persist this to spend it later. */
export type FlowOutputNote = {
  amount: bigint;
  /** Owner public key field element (recipient or self). */
  pubkey: bigint;
  blinding: bigint;
  commitment: bigint;
  /** The leaf index, filled in once the indexer observes the commitment. */
  leafIndex: number | null;
  /** ECIES blob the recipient trial-decrypts to recover the note. */
  encrypted: Uint8Array;
};

/** Shared pool wiring — supplied from SHIELD env (see flow-config.ts callers). */
export type ShieldFlowConfig = {
  /** Pinned `talise_privacy` package id. */
  packageId: string;
  /** The shared `ShieldedPool<CoinType>` object id. */
  poolObjectId: string;
  /** CoinType type tag. Defaults to USDsui. */
  coinType?: string;
  /**
   * Optional compliance registry id. Omit for the deployed decoupled pool
   * (whose `transact` takes no registry); supply for a compliance-wired pool.
   */
  complianceRegistryId?: string;
  /** Base path for the `/api/shield/*` routes (default ""). */
  apiBase?: string;
  /** Auth/credentials forwarding for the fetch calls (default same-origin). */
  fetchInit?: RequestInit;
};

type RelayerInfo = { address: string; maxRelayerFee: bigint };
// `root` is the root the returned path AUTHENTICATES to — the proof's public
// root MUST equal this for the real input or the circuit is unsatisfiable. We
// carry it so the proof root can never drift from the path it was built with.
type PathResult = { leafIndex: number; pathPairs: [string, string][]; root: string };

// ── API helpers ─────────────────────────────────────────────────────────────

async function getRelayer(cfg: ShieldFlowConfig): Promise<RelayerInfo> {
  const res = await fetch(`${cfg.apiBase ?? ""}/api/shield/relayer`, {
    ...cfg.fetchInit,
    method: "GET",
  });
  if (!res.ok) throw new Error(`relayer lookup failed (${res.status})`);
  const j = (await res.json()) as { address: string; maxRelayerFee: string };
  return { address: j.address, maxRelayerFee: BigInt(j.maxRelayerFee) };
}

async function getPath(
  cfg: ShieldFlowConfig,
  body: { commitment?: string; leafIndex?: number; dummy?: boolean }
): Promise<PathResult> {
  const res = await fetch(`${cfg.apiBase ?? ""}/api/shield/merkle-path`, {
    ...cfg.fetchInit,
    method: "POST",
    headers: { "content-type": "application/json", ...(cfg.fetchInit?.headers ?? {}) },
    body: JSON.stringify({ coinType: cfg.coinType ?? USDSUI_TYPE, ...body }),
  });
  if (!res.ok) throw new Error(`merkle-path failed (${res.status})`);
  const j = (await res.json()) as {
    leafIndex?: number;
    pathPairs: [string, string][];
    root?: string;
  };
  return { leafIndex: j.leafIndex ?? 0, pathPairs: j.pathPairs, root: j.root ?? "0" };
}

async function submitRelay(
  cfg: ShieldFlowConfig,
  txBytes: string,
  exitAddress?: string
): Promise<{ digest: string }> {
  const res = await fetch(`${cfg.apiBase ?? ""}/api/shield/relay`, {
    ...cfg.fetchInit,
    method: "POST",
    headers: { "content-type": "application/json", ...(cfg.fetchInit?.headers ?? {}) },
    body: JSON.stringify({ txBytes, ...(exitAddress ? { exitAddress } : {}) }),
  });
  const j = (await res.json()) as { digest?: string; error?: string };
  if (!res.ok) throw new Error(j.error || `relay failed (${res.status})`);
  if (!j.digest) throw new Error("relay returned no digest");
  return { digest: j.digest };
}

// ── Witness assembly (mirrors circuit/src/prover.rs) ─────────────────────────

type WitnessInput = {
  privateKey: bigint;
  amount: bigint;
  blinding: bigint;
  pathIndex: bigint;
  pathPairs: [string, string][];
  nullifier: bigint;
  /** Root the path authenticates to — for a REAL (non-zero) input the proof's
   *  public root MUST equal this, else the membership constraint fails. */
  pathRoot: bigint;
};
type WitnessOutput = {
  pubkey: bigint;
  amount: bigint;
  blinding: bigint;
  commitment: bigint;
};

/**
 * Build a fresh ZERO-amount dummy input. Its nullifier must be globally unique
 * (the on-chain set rejects a re-spent nullifier — the exact collision that bit
 * the manual demos), so the dummy key + blinding are RANDOM per call, and its
 * Merkle path is the all-zero dummy path (amount 0 ⇒ membership check skipped).
 */
async function dummyInput(cfg: ShieldFlowConfig, pool: bigint, pathIndex: bigint): Promise<WitnessInput> {
  const privateKey = randomField();
  const blinding = randomField();
  const pubkey = hash1(privateKey);
  const commitment = commit(0n, pubkey, blinding, pool);
  const nullifier = nullifierFor(privateKey, commitment, pathIndex);
  const { pathPairs, root } = await getPath(cfg, { dummy: true });
  // amount 0 ⇒ membership skipped, so pathRoot is unused for a dummy.
  return { privateKey, amount: 0n, blinding, pathIndex, pathPairs, nullifier, pathRoot: BigInt(root) };
}

/** Turn a real {@link FlowInputNote} into a witness input (fetch its live path
 *  AND the root that path folds to — they MUST stay together). */
async function realInput(cfg: ShieldFlowConfig, pool: bigint, note: FlowInputNote): Promise<WitnessInput> {
  const pathIndex = BigInt(note.leafIndex);
  const { pathPairs, root } = await getPath(cfg, { commitment: dec(note.commitment) });
  const nullifier = nullifierFor(note.privateKey, note.commitment, pathIndex);
  return {
    privateKey: note.privateKey,
    amount: note.amount,
    blinding: note.blinding,
    pathIndex,
    pathPairs,
    nullifier,
    pathRoot: BigInt(root),
  };
}

/** Build an output note to `pubkey` for `amount` (random blinding). */
function makeOutput(pool: bigint, pubkey: bigint, amount: bigint): WitnessOutput {
  const blinding = randomField();
  return { pubkey, amount, blinding, commitment: commit(amount, pubkey, blinding, pool) };
}

/**
 * Assemble the circuit `ProofInput` from two inputs + two outputs. The circuit
 * enforces null0 != null1 and value conservation `sum_ins + public == sum_outs`.
 */
function assembleProofInput(args: {
  pool: bigint;
  root: bigint;
  publicAmount: bigint;
  ins: [WitnessInput, WitnessInput];
  outs: [WitnessOutput, WitnessOutput];
}): ProofInput {
  const { pool, root, publicAmount, ins, outs } = args;
  if (ins[0].nullifier === ins[1].nullifier) {
    throw new Error("input nullifiers collide — regenerate a dummy input");
  }
  return {
    vortex: dec(pool),
    root: dec(root),
    publicAmount: dec(publicAmount),
    inputNullifier0: dec(ins[0].nullifier),
    inputNullifier1: dec(ins[1].nullifier),
    outputCommitment0: dec(outs[0].commitment),
    outputCommitment1: dec(outs[1].commitment),
    // Unsponsored `transact` path: account secret is zero (the circuit then
    // skips the secret-equality check; proof.move supplies hashed_secret == 0).
    hashedAccountSecret: "0",
    accountSecret: "0",
    inPrivateKey0: dec(ins[0].privateKey),
    inPrivateKey1: dec(ins[1].privateKey),
    inAmount0: dec(ins[0].amount),
    inAmount1: dec(ins[1].amount),
    inBlinding0: dec(ins[0].blinding),
    inBlinding1: dec(ins[1].blinding),
    inPathIndex0: dec(ins[0].pathIndex),
    inPathIndex1: dec(ins[1].pathIndex),
    merklePath0: ins[0].pathPairs,
    merklePath1: ins[1].pathPairs,
    outPublicKey0: dec(outs[0].pubkey),
    outPublicKey1: dec(outs[1].pubkey),
    outAmount0: dec(outs[0].amount),
    outAmount1: dec(outs[1].amount),
    outBlinding0: dec(outs[0].blinding),
    outBlinding1: dec(outs[1].blinding),
  };
}

/** Encrypt both output notes to their recipients, returning the ext blobs + records. */
async function encryptOutputs(
  pool: bigint,
  outs: [WitnessOutput, WitnessOutput],
  encKeys: [RecipientEncKey, RecipientEncKey]
): Promise<{ blobs: [Uint8Array, Uint8Array]; notes: [Omit<FlowOutputNote, "leafIndex">, Omit<FlowOutputNote, "leafIndex">] }> {
  const enc = async (o: WitnessOutput, k: RecipientEncKey) => {
    const blob = await encryptNote(
      { amount: o.amount, pubkey: o.pubkey, blinding: o.blinding, pool },
      k
    );
    return { blob, rec: { amount: o.amount, pubkey: o.pubkey, blinding: o.blinding, commitment: o.commitment, encrypted: blob } };
  };
  const [a, b] = await Promise.all([enc(outs[0], encKeys[0]), enc(outs[1], encKeys[1])]);
  return { blobs: [a.blob, b.blob], notes: [a.rec, b.rec] };
}

/** Pool object id → field element (BigInt(addr) mod r), the circuit's `vortex`. */
function poolField(poolObjectId: string): bigint {
  return mod(BigInt(poolObjectId));
}

/** Self enc key (derive the recipient point from the spending key). */
async function selfEncKey(kp: ShieldKeypair): Promise<Uint8Array> {
  const d = await deriveShieldEncScalar(kp.spendingKey);
  return encPublicKeyFromScalar(d);
}

// ── Common driver: assemble → prove → encrypt → build → relay ────────────────

async function runOp(args: {
  cfg: ShieldFlowConfig;
  root: bigint;
  publicAmount: bigint;
  ins: [WitnessInput, WitnessInput];
  outs: [WitnessOutput, WitnessOutput];
  encKeys: [RecipientEncKey, RecipientEncKey];
  ext: { value: bigint; valueSign: boolean };
  depositCoinId?: string;
  zeroCoinSourceId?: string;
  outputRecipient?: string;
  exitAddress?: string;
}): Promise<{ digest: string; outputs: FlowOutputNote[] }> {
  const { cfg, root, publicAmount, ins, outs, encKeys, ext } = args;
  const pool = poolField(cfg.poolObjectId);

  const relayer = await getRelayer(cfg);

  // 1. Prove (WASM worker, real entropy).
  const input = assembleProofInput({ pool, root, publicAmount, ins, outs });
  const proof: ProofInputs = await proveTransact(input);

  // 2. Encrypt the two output notes.
  const { blobs, notes } = await encryptOutputs(pool, outs, encKeys);

  // 3. ext_data — relayer + (zero) fee + the two ECIES blobs.
  const extData: ExtDataInput = {
    value: ext.value,
    valueSign: ext.valueSign,
    relayer: relayer.address,
    relayerFee: 0n,
    encryptedOutput0: blobs[0],
    encryptedOutput1: blobs[1],
  };

  // 4. Build the transact PTB (matches the deployed decoupled pool).
  const tx = buildTransact({
    packageId: cfg.packageId,
    coinType: cfg.coinType ?? USDSUI_TYPE,
    poolObjectId: cfg.poolObjectId,
    complianceRegistryId: cfg.complianceRegistryId,
    poolAddress: cfg.poolObjectId,
    proof,
    ext: extData,
    depositCoinId: args.depositCoinId,
    zeroCoinSourceId: args.zeroCoinSourceId,
    outputRecipient: args.outputRecipient,
  });

  // 5. Relay (the relayer sets sender/gas, so serialize the unbuilt tx).
  const txBytes = await tx.toJSON();
  const { digest } = await submitRelay(cfg, txBytes, args.exitAddress);

  return { digest, outputs: notes.map((n) => ({ ...n, leafIndex: null })) };
}

// ── Public entry points ──────────────────────────────────────────────────────

/**
 * DEPOSIT: move `amount` of cleartext coin INTO the shielded pool, producing one
 * shielded note owned by the user (out0) and a zero note (out1). Two random
 * zero-amount dummy inputs satisfy the 2-in shape. public_amount == +amount.
 *
 * @param depositCoinId a `Coin<CoinType>` object of exactly `amount`.
 */
export async function shieldDeposit(args: {
  cfg: ShieldFlowConfig;
  keypair: ShieldKeypair;
  amount: bigint;
  depositCoinId: string;
  /** Current pool root (decimal). Fetch from the pool object before calling. */
  root: bigint;
}): Promise<{ digest: string; outputs: FlowOutputNote[] }> {
  const { cfg, keypair, amount, root } = args;
  const pool = poolField(cfg.poolObjectId);
  const ins: [WitnessInput, WitnessInput] = [
    await dummyInput(cfg, pool, 0n),
    await dummyInput(cfg, pool, 1n),
  ];
  const outs: [WitnessOutput, WitnessOutput] = [
    makeOutput(pool, keypair.publicKey, amount),
    makeOutput(pool, keypair.publicKey, 0n),
  ];
  const selfKey = await selfEncKey(keypair);
  return runOp({
    cfg,
    root,
    publicAmount: mod(amount),
    ins,
    outs,
    encKeys: [selfKey, selfKey],
    ext: { value: amount, valueSign: true },
    depositCoinId: args.depositCoinId,
  });
}

/** A deposit proof + blobs, serialized for POST /api/shield/deposit/prepare. */
export type PreparedShieldDeposit = {
  proof: {
    proofPointsHex: string;
    root: string;
    publicValue: string;
    inputNullifier0: string;
    inputNullifier1: string;
    outputCommitment0: string;
    outputCommitment1: string;
  };
  enc0B64: string;
  enc1B64: string;
  /** The spendable output note (out0) — persist + spend after it indexes. */
  outputNote: { amount: string; blinding: string; commitment: string };
};

const toHex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const toB64 = (b: Uint8Array) =>
  typeof btoa === "function"
    ? btoa(String.fromCharCode(...b))
    : Buffer.from(b).toString("base64");

/**
 * Build + PROVE a deposit, but DO NOT submit. The native bridge needs the proof
 * client-side (note secrets never leave the device) and the deposit PTB built +
 * USER-signed server-side via zkLogin + Onara (the relayer cannot sign the user's
 * coin). Returns the serialized proof + ECIES blobs for /api/shield/deposit/prepare,
 * and the spendable output note so the caller can run the withdraw leg once the
 * commitment indexes. Mirrors {@link shieldDeposit}'s witness exactly, minus relay.
 */
export async function proveShieldDeposit(args: {
  cfg: ShieldFlowConfig;
  keypair: ShieldKeypair;
  amount: bigint;
  /** Current pool root (decimal) — must be a known on-chain root. */
  root: bigint;
}): Promise<PreparedShieldDeposit> {
  const { cfg, keypair, amount, root } = args;
  const pool = poolField(cfg.poolObjectId);
  const ins: [WitnessInput, WitnessInput] = [
    await dummyInput(cfg, pool, 0n),
    await dummyInput(cfg, pool, 1n),
  ];
  const outs: [WitnessOutput, WitnessOutput] = [
    makeOutput(pool, keypair.publicKey, amount),
    makeOutput(pool, keypair.publicKey, 0n),
  ];
  const input = assembleProofInput({ pool, root, publicAmount: mod(amount), ins, outs });
  const proof: ProofInputs = await proveTransact(input);

  const selfKey = await selfEncKey(keypair);
  const { blobs } = await encryptOutputs(pool, outs, [selfKey, selfKey]);

  return {
    proof: {
      proofPointsHex: toHex(proof.proofPoints),
      root: dec(proof.root),
      publicValue: dec(proof.publicValue),
      inputNullifier0: dec(proof.inputNullifier0),
      inputNullifier1: dec(proof.inputNullifier1),
      outputCommitment0: dec(proof.outputCommitment0),
      outputCommitment1: dec(proof.outputCommitment1),
    },
    enc0B64: toB64(blobs[0]),
    enc1B64: toB64(blobs[1]),
    outputNote: {
      amount: dec(outs[0].amount),
      blinding: dec(outs[0].blinding),
      commitment: dec(outs[0].commitment),
    },
  };
}

/**
 * WITHDRAW: spend `inputNotes` (1 or 2) and send `amount` OUT of the pool to
 * `exitAddress`; any remainder returns as a shielded change note to the user.
 * public_amount == (r − amount) (field-negated). The relayer transfers the
 * `transact` return coin (the unshielded funds) to `outputRecipient`.
 */
export async function shieldWithdraw(args: {
  cfg: ShieldFlowConfig;
  keypair: ShieldKeypair;
  inputNotes: [FlowInputNote] | [FlowInputNote, FlowInputNote];
  amount: bigint;
  exitAddress: string;
  /** A relayer-owned coin to split a zero deposit-coin from. */
  zeroCoinSourceId: string;
  root: bigint;
}): Promise<{ digest: string; outputs: FlowOutputNote[] }> {
  const { cfg, keypair, inputNotes, amount, exitAddress } = args;
  const pool = poolField(cfg.poolObjectId);

  const ins: [WitnessInput, WitnessInput] = [
    await realInput(cfg, pool, inputNotes[0]),
    inputNotes[1]
      ? await realInput(cfg, pool, inputNotes[1])
      : await dummyInput(cfg, pool, 1n),
  ];
  const totalIn = ins[0].amount + ins[1].amount;
  const change = totalIn - amount;
  if (change < 0n) throw new Error("withdraw exceeds spent notes");
  // If a SECOND real note is spent, both paths must fold to the same root.
  if (inputNotes[1] && ins[0].pathRoot !== ins[1].pathRoot) {
    throw new Error("input note paths disagree on the root — retry");
  }
  const outs: [WitnessOutput, WitnessOutput] = [
    makeOutput(pool, keypair.publicKey, change),
    makeOutput(pool, keypair.publicKey, 0n),
  ];
  const selfKey = await selfEncKey(keypair);
  return runOp({
    cfg,
    // Bind the public root to the SAME read that produced the spent note's path
    // — NOT a stale snapshot the caller captured earlier (that mismatch made the
    // membership constraint unsatisfiable → proof failed → withdraw never sent).
    root: ins[0].pathRoot,
    publicAmount: mod(0n - amount),
    ins,
    outs,
    encKeys: [selfKey, selfKey],
    ext: { value: amount, valueSign: false },
    zeroCoinSourceId: args.zeroCoinSourceId,
    outputRecipient: exitAddress,
    exitAddress,
  });
}

/** Is this nullifier already spent on-chain? Conservative: a failed lookup
 *  returns false (treat as unspent) — the on-chain nullifier set is the real
 *  guard, so the worst case is a withdraw that aborts harmlessly, never a spend. */
async function isSpent(cfg: ShieldFlowConfig, nullifier: bigint): Promise<boolean> {
  try {
    const q = `coinType=${encodeURIComponent(cfg.coinType ?? USDSUI_TYPE)}&nullifier=${dec(nullifier)}`;
    const res = await fetch(`${cfg.apiBase ?? ""}/api/shield/nullifier?${q}`, {
      ...cfg.fetchInit,
      method: "GET",
    });
    if (!res.ok) return false;
    const j = (await res.json()) as { spent?: Record<string, boolean> };
    return !!j.spent?.[dec(nullifier)];
  } catch {
    return false;
  }
}

/**
 * SHIELDED BALANCE: the user's private pocket = the sum of their UNSPENT notes.
 * Scans the commitments feed (trial-decrypt with the viewing key), skips spent +
 * zero notes, sums the rest. Read-only; never signs.
 */
export async function shieldedBalanceMicros(args: {
  cfg: ShieldFlowConfig;
  keypair: ShieldKeypair;
}): Promise<bigint> {
  const { cfg, keypair } = args;
  const viewingKey = await deriveShieldEncScalar(keypair.spendingKey);
  let notes: Awaited<ReturnType<typeof scanNotes>>;
  try {
    notes = await scanNotes(viewingKey, {
      baseUrl: `${cfg.apiBase ?? ""}/api/shield/commitments`,
      fetch: ((u: string) => fetch(u, { ...cfg.fetchInit })) as typeof fetch,
    });
  } catch {
    return 0n;
  }
  let total = 0n;
  for (const n of notes) {
    if (n.amount <= 0n || n.leafIndex == null) continue;
    const nf = nullifierFor(keypair.spendingKey, n.commitment, BigInt(n.leafIndex));
    if (await isSpent(cfg, nf).catch(() => false)) continue;
    total += n.amount;
  }
  return total;
}

/**
 * SCAN-FIRST send: a shielded note IS spendable balance. Before depositing fresh
 * funds, look for an UNSPENT note the user already owns whose amount matches the
 * send; if found, spend THAT to the recipient (a relayer-signed withdraw) and
 * skip the deposit entirely. This (a) completes a previously-stranded deposit
 * whose withdraw never fired — the funds are already in the pool — and (b) makes
 * sends cheaper when shielded balance exists. Returns the withdraw digest, or
 * null when no matching unspent note exists (caller falls back to deposit→withdraw).
 */
export async function spendExistingNote(args: {
  cfg: ShieldFlowConfig;
  keypair: ShieldKeypair;
  amount: bigint;
  exitAddress: string;
  /** A relayer-owned coin to split the zero deposit-coin from (from /api/shield/relayer). */
  zeroCoinSourceId: string;
  /** Current pool root (decimal) — must include the note's leaf. */
  root: bigint;
}): Promise<{ digest: string; outputs: FlowOutputNote[] } | null> {
  const { cfg, keypair, amount } = args;
  const viewingKey = await deriveShieldEncScalar(keypair.spendingKey);
  // Scanning is best-effort: a scan error means "couldn't check balance" → return
  // null so the caller deposits normally. But once a matching UNSPENT note is
  // found, the withdraw is NOT swallowed — if it throws, it propagates so the
  // caller surfaces the error and does NOT deposit again (no stranded-deposit loop).
  let notes: Awaited<ReturnType<typeof scanNotes>>;
  try {
    notes = await scanNotes(viewingKey, {
      baseUrl: `${cfg.apiBase ?? ""}/api/shield/commitments`,
      fetch: ((u: string) => fetch(u, { ...cfg.fetchInit })) as typeof fetch,
    });
  } catch {
    return null;
  }
  for (const n of notes) {
    if (n.amount !== amount || n.leafIndex == null) continue;
    const nf = nullifierFor(keypair.spendingKey, n.commitment, BigInt(n.leafIndex));
    if (await isSpent(cfg, nf).catch(() => false)) continue;
    return shieldWithdraw({
      cfg,
      keypair,
      inputNotes: [
        {
          privateKey: keypair.spendingKey,
          amount: n.amount,
          blinding: n.blinding,
          leafIndex: n.leafIndex,
          commitment: n.commitment,
        },
      ],
      amount,
      exitAddress: args.exitAddress,
      zeroCoinSourceId: args.zeroCoinSourceId,
      root: args.root,
    });
  }
  return null;
}

/**
 * RECOVERY SWEEP: scan ALL of the user's UNSPENT notes and withdraw each back to
 * `destination` (the user's own wallet). One-tap reclaim of a shielded balance
 * stranded by earlier failed withdraws. Each note is withdrawn at its full
 * amount (no change), sequentially; a per-note failure is recorded and the sweep
 * continues (best-effort — never aborts the whole sweep on one bad note). The
 * withdraw root is bound to each note's own freshly-fetched path (see
 * shieldWithdraw), so sequential withdraws stay valid as the tree grows.
 */
export async function sweepShieldedBalance(args: {
  cfg: ShieldFlowConfig;
  keypair: ShieldKeypair;
  /** Where the reclaimed cleartext USDsui lands (the user's own address). */
  destination: string;
  /** A relayer-owned coin to split the zero deposit-coin from. */
  zeroCoinSourceId: string;
}): Promise<{ swept: { digest: string; amountMicros: string }[]; failed: number; totalMicros: string }> {
  const { cfg, keypair, destination, zeroCoinSourceId } = args;
  const viewingKey = await deriveShieldEncScalar(keypair.spendingKey);
  let notes: Awaited<ReturnType<typeof scanNotes>> = [];
  try {
    notes = await scanNotes(viewingKey, {
      baseUrl: `${cfg.apiBase ?? ""}/api/shield/commitments`,
      fetch: ((u: string) => fetch(u, { ...cfg.fetchInit })) as typeof fetch,
    });
  } catch {
    return { swept: [], failed: 0, totalMicros: "0" };
  }

  const swept: { digest: string; amountMicros: string }[] = [];
  let failed = 0;
  let total = 0n;
  for (const n of notes) {
    if (n.amount <= 0n || n.leafIndex == null) continue; // skip zero / unplaced notes
    const nf = nullifierFor(keypair.spendingKey, n.commitment, BigInt(n.leafIndex));
    if (await isSpent(cfg, nf).catch(() => false)) continue; // already spent
    try {
      const { digest } = await shieldWithdraw({
        cfg,
        keypair,
        inputNotes: [
          {
            privateKey: keypair.spendingKey,
            amount: n.amount,
            blinding: n.blinding,
            leafIndex: n.leafIndex,
            commitment: n.commitment,
          },
        ],
        amount: n.amount, // full note → no change
        exitAddress: destination,
        zeroCoinSourceId,
        root: 0n, // ignored — shieldWithdraw binds the proof root to the note's path
      });
      swept.push({ digest, amountMicros: dec(n.amount) });
      total += n.amount;
    } catch {
      failed++;
    }
  }
  return { swept, failed, totalMicros: dec(total) };
}

/**
 * INTERNAL TRANSFER: spend `inputNotes` and re-split into a note for the
 * recipient (`recipientPubkey` + `recipientEncKey`) and a change note for the
 * user — with ZERO coin movement on-chain. public_amount == 0.
 */
export async function shieldTransfer(args: {
  cfg: ShieldFlowConfig;
  keypair: ShieldKeypair;
  inputNotes: [FlowInputNote] | [FlowInputNote, FlowInputNote];
  amount: bigint;
  recipientPubkey: bigint;
  recipientEncKey: RecipientEncKey;
  /** A relayer-owned coin to split a zero deposit-coin from. */
  zeroCoinSourceId: string;
  root: bigint;
}): Promise<{ digest: string; outputs: FlowOutputNote[] }> {
  const { cfg, keypair, inputNotes, amount, recipientPubkey, recipientEncKey } = args;
  const pool = poolField(cfg.poolObjectId);

  const ins: [WitnessInput, WitnessInput] = [
    await realInput(cfg, pool, inputNotes[0]),
    inputNotes[1]
      ? await realInput(cfg, pool, inputNotes[1])
      : await dummyInput(cfg, pool, 1n),
  ];
  const totalIn = ins[0].amount + ins[1].amount;
  const change = totalIn - amount;
  if (change < 0n) throw new Error("transfer exceeds spent notes");
  if (inputNotes[1] && ins[0].pathRoot !== ins[1].pathRoot) {
    throw new Error("input note paths disagree on the root — retry");
  }
  // out0 → recipient, out1 → change back to self.
  const outs: [WitnessOutput, WitnessOutput] = [
    makeOutput(pool, recipientPubkey, amount),
    makeOutput(pool, keypair.publicKey, change),
  ];
  const selfKey = await selfEncKey(keypair);
  return runOp({
    cfg,
    // Bind the public root to the path's own root (see shieldWithdraw).
    root: ins[0].pathRoot,
    publicAmount: 0n,
    ins,
    outs,
    encKeys: [recipientEncKey, selfKey],
    ext: { value: 0n, valueSign: true },
    zeroCoinSourceId: args.zeroCoinSourceId,
  });
}

/**
 * SCAN-FIRST shielded transfer: a shielded note IS spendable balance. Look for an
 * UNSPENT note the user already owns whose amount covers `amount`; if found, spend
 * THAT to the recipient via a HIDDEN-AMOUNT shieldTransfer (public_amount == 0, so
 * no amount or recipient lands on-chain) — change returns to self. Mirrors
 * spendExistingNote's scan loop: scanning is best-effort (a scan error means
 * "couldn't check balance" → return null so the caller falls back), but once a
 * covering UNSPENT note is found the transfer is NOT swallowed — if it throws it
 * propagates so the caller surfaces the error. Uses the FIRST unspent note whose
 * amount >= the send amount. Returns null ONLY when no covering unspent note exists.
 */
export async function spendOrTransferToShield(args: {
  cfg: ShieldFlowConfig;
  keypair: ShieldKeypair;
  amount: bigint;
  recipientPubkey: bigint;
  recipientEncKey: Uint8Array;
  /** A relayer-owned coin to split a zero deposit-coin from. */
  zeroCoinSourceId: string;
}): Promise<{ digest: string; outputs: FlowOutputNote[] } | null> {
  const { cfg, keypair, amount } = args;
  const viewingKey = await deriveShieldEncScalar(keypair.spendingKey);
  let notes: Awaited<ReturnType<typeof scanNotes>>;
  try {
    notes = await scanNotes(viewingKey, {
      baseUrl: `${cfg.apiBase ?? ""}/api/shield/commitments`,
      fetch: ((u: string) => fetch(u, { ...cfg.fetchInit })) as typeof fetch,
    });
  } catch {
    return null;
  }
  for (const n of notes) {
    if (n.amount < amount || n.leafIndex == null) continue;
    const nf = nullifierFor(keypair.spendingKey, n.commitment, BigInt(n.leafIndex));
    if (await isSpent(cfg, nf).catch(() => false)) continue;
    return shieldTransfer({
      cfg,
      keypair,
      inputNotes: [
        {
          privateKey: keypair.spendingKey,
          amount: n.amount,
          blinding: n.blinding,
          leafIndex: n.leafIndex,
          commitment: n.commitment,
        },
      ],
      amount,
      recipientPubkey: args.recipientPubkey,
      recipientEncKey: args.recipientEncKey,
      zeroCoinSourceId: args.zeroCoinSourceId,
      root: 0n,
    });
  }
  return null;
}
