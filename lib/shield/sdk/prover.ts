/**
 * Talise shielded-pool prover — main-thread client for the Web Worker prover.
 *
 * Public surface:
 *   • prove(input)                  → ProofOutput   (off-thread Groth16 prove)
 *   • verifyProof(proof)            → boolean       (off-thread in-wasm verify)
 *   • buildDepositInput(...)        → ProofInput    (deposit witness assembler)
 *   • preloadProvingKey()           → warm the cache before the user proves
 *
 * Asset hosting (static, served from web/public/shield/):
 *   • /shield/talise_privacy_circuit.js       — wasm-bindgen `--target web` glue
 *   • /shield/talise_privacy_circuit_bg.wasm  — ~1.4MB circuit binary
 *   • /shield/proving_key.bin                 — ~3.8MB arkworks proving key
 *   • /shield/vk_sui.hex                       — verifying key hex (Sui format)
 *
 * The proving key is fetched ONCE and cached in IndexedDB (keyed by a version
 * tag) so repeat sessions skip the 3.8MB download. It is also kept in memory for
 * the lifetime of the tab. Regenerating the dev keys means bumping PK_CACHE_VER.
 *
 * Entropy: the WASM proof randomness comes from getrandom(js) ->
 * crypto.getRandomValues — REAL entropy, never a fixed seed.
 */

/** Hosted asset paths (see web/public/shield/). */
export const SHIELD_ASSETS = {
  glue: "/shield/talise_privacy_circuit.js",
  wasm: "/shield/talise_privacy_circuit_bg.wasm",
  provingKey: "/shield/proving_key.bin",
  verifyingKey: "/shield/vk_sui.hex",
} as const;

/** Bump when the dev keys are regenerated to bust the IndexedDB PK cache. */
const PK_CACHE_VER = "v1";
const PK_DB = "talise-shield";
const PK_STORE = "keys";
const PK_KEY = `proving_key:${PK_CACHE_VER}`;

/** ProofOutput as produced by the WASM `prove`. */
export type ProofOutput = {
  /** Compressed G1, 32 bytes. */
  proofA: number[];
  /** Compressed G2, 64 bytes. */
  proofB: number[];
  /** Compressed G1, 32 bytes. */
  proofC: number[];
  /** 8 public inputs as decimal strings, allocation order. */
  publicInputs: string[];
  /** proofA‖proofB‖proofC (128 bytes) hex — the bytes the Move verifier wants. */
  proofSerializedHex: string;
  /** 8 × 32-byte LE field elements hex — Move bcs::to_bytes(&u256) layout. */
  publicInputsSerializedHex: string;
};

/** Circuit input — every value a u256 decimal (or 0x-hex) string. */
export type ProofInput = {
  vortex: string;
  root: string;
  publicAmount: string;
  inputNullifier0: string;
  inputNullifier1: string;
  outputCommitment0: string;
  outputCommitment1: string;
  hashedAccountSecret: string;
  accountSecret: string;
  inPrivateKey0: string;
  inPrivateKey1: string;
  inAmount0: string;
  inAmount1: string;
  inBlinding0: string;
  inBlinding1: string;
  inPathIndex0: string;
  inPathIndex1: string;
  merklePath0: [string, string][];
  merklePath1: [string, string][];
  outPublicKey0: string;
  outPublicKey1: string;
  outAmount0: string;
  outAmount1: string;
  outBlinding0: string;
  outBlinding1: string;
};

// ---------------------------------------------------------------------------
// Proving-key cache (IndexedDB + in-memory)
// ---------------------------------------------------------------------------

let pkHexMem: string | null = null;

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function idbGet(key: string): Promise<ArrayBuffer | undefined> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(undefined);
    const open = indexedDB.open(PK_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(PK_STORE);
    open.onerror = () => resolve(undefined);
    open.onsuccess = () => {
      const db = open.result;
      try {
        const tx = db.transaction(PK_STORE, "readonly");
        const req = tx.objectStore(PK_STORE).get(key);
        req.onsuccess = () => resolve(req.result as ArrayBuffer | undefined);
        req.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    };
  });
}

function idbPut(key: string, val: ArrayBuffer): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve();
    const open = indexedDB.open(PK_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(PK_STORE);
    open.onerror = () => resolve();
    open.onsuccess = () => {
      const db = open.result;
      try {
        const tx = db.transaction(PK_STORE, "readwrite");
        tx.objectStore(PK_STORE).put(val, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    };
  });
}

/**
 * Fetch the proving key hex, using the IndexedDB cache when available. Safe to
 * call repeatedly — the in-memory copy is reused for the tab's lifetime.
 */
export async function preloadProvingKey(): Promise<string> {
  if (pkHexMem) return pkHexMem;

  const cached = await idbGet(PK_KEY);
  if (cached) {
    pkHexMem = toHex(new Uint8Array(cached));
    return pkHexMem;
  }

  const res = await fetch(SHIELD_ASSETS.provingKey);
  if (!res.ok) throw new Error(`failed to fetch proving key: ${res.status}`);
  const buf = await res.arrayBuffer();
  await idbPut(PK_KEY, buf);
  pkHexMem = toHex(new Uint8Array(buf));
  return pkHexMem;
}

let vkHexMem: string | null = null;

/** Fetch the verifying key hex (Sui format), cached in memory. */
export async function loadVerifyingKey(): Promise<string> {
  if (vkHexMem) return vkHexMem;
  const res = await fetch(SHIELD_ASSETS.verifyingKey);
  if (!res.ok) throw new Error(`failed to fetch verifying key: ${res.status}`);
  vkHexMem = (await res.text()).trim();
  return vkHexMem;
}

// ---------------------------------------------------------------------------
// Worker management
// ---------------------------------------------------------------------------

type WorkerReply =
  | { id: number; ok: true; result: string | boolean }
  | { id: number; ok: false; error: string };

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<
  number,
  { resolve: (v: string | boolean) => void; reject: (e: Error) => void }
>();

function getWorker(): Worker {
  if (worker) return worker;
  // `new URL(..., import.meta.url)` lets the bundler emit the worker chunk.
  worker = new Worker(new URL("./prover.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (e: MessageEvent<WorkerReply>) => {
    const reply = e.data;
    const p = pending.get(reply.id);
    if (!p) return;
    pending.delete(reply.id);
    if (reply.ok) p.resolve(reply.result);
    else p.reject(new Error(reply.error));
  };
  worker.onerror = (e) => {
    for (const [, p] of pending) p.reject(new Error(e.message || "worker error"));
    pending.clear();
  };
  return worker;
}

function post(msg: Record<string, unknown>): Promise<string | boolean> {
  const id = ++seq;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ ...msg, id });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a Groth16 proof off the main thread. Loads (and caches) the proving
 * key on first use. Resolves with the parsed {@link ProofOutput}.
 */
export async function prove(input: ProofInput): Promise<ProofOutput> {
  const provingKeyHex = await preloadProvingKey();
  const result = (await post({
    type: "prove",
    input,
    provingKeyHex,
  })) as string;
  return JSON.parse(result) as ProofOutput;
}

/**
 * Verify a proof in-wasm against the hosted verifying key (off the main thread).
 * Handy for a client-side self-check before handing the proof to the relayer.
 */
export async function verifyProof(proof: ProofOutput): Promise<boolean> {
  const verifyingKeyHex = await loadVerifyingKey();
  return (await post({
    type: "verify",
    proofJson: JSON.stringify(proof),
    verifyingKeyHex,
  })) as boolean;
}

/** The 8 public-signal field names, in circuit allocation order. */
export const PUBLIC_INPUT_ORDER = [
  "pool",
  "root",
  "publicValue",
  "nullifier0",
  "nullifier1",
  "commitment0",
  "commitment1",
  "hashedSecret",
] as const;
