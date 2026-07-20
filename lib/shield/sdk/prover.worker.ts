/**
 * Talise shielded-pool Groth16 prover, Web Worker.
 *
 * Runs the arkworks BN254 Groth16 prover (compiled to WASM from
 * `move/talise-privacy/circuit`, exported as `prove`/`verify`/`build_deposit_input`)
 * OFF the main thread, so a multi-second proof never freezes the UI.
 *
 * The WASM glue + binary and the ~3.8MB proving key are hosted as static assets
 * under `web/public/shield/` (see prover.ts SHIELD_ASSETS). The worker:
 *   1. dynamically imports the wasm-bindgen `--target web` glue,
 *   2. fetches + instantiates the .wasm,
 *   3. fetches the proving key hex (cached by the client across calls),
 *   4. calls `prove(inputJson, provingKeyHex)` and posts the proof back.
 *
 * Protocol (postMessage):
 *   in:  { id, type: "prove",  input: object,  provingKeyHex: string }
 *        { id, type: "verify", proofJson: string, verifyingKeyHex: string }
 *   out: { id, ok: true,  result: <ProofOutput JSON | boolean> }
 *        { id, ok: false, error: string }
 *
 * Note on entropy: the WASM uses getrandom(js) -> crypto.getRandomValues, so
 * proof randomness is REAL browser entropy, never a fixed seed.
 */

/// <reference lib="webworker" />

type WasmModule = {
  default: (moduleOrPath?: unknown) => Promise<unknown>;
  prove: (inputJson: string, provingKeyHex: string) => string;
  verify: (proofJson: string, verifyingKeyHex: string) => boolean;
  build_deposit_input: (
    poolHex: string,
    rootDec: string,
    amount: bigint,
    out0: bigint,
    out1: bigint
  ) => string;
};

type ProveMsg = {
  id: number;
  type: "prove";
  input: unknown;
  provingKeyHex: string;
};
type VerifyMsg = {
  id: number;
  type: "verify";
  proofJson: string;
  verifyingKeyHex: string;
};
// Warm-up: instantiate the WASM (fetch + compile the ~1.4MB binary) without
// proving, so the first real prove() doesn't pay that cost. loadWasm() runs at
// the top of onmessage for every message, so handling "warm" just means
// acking once it's done.
type WarmMsg = { id: number; type: "warm" };
type InMsg = ProveMsg | VerifyMsg | WarmMsg;

// Where the static WASM glue + binary live (served from public/).
const GLUE_URL = "/shield/talise_privacy_circuit.js";
const WASM_URL = "/shield/talise_privacy_circuit_bg.wasm";

let wasmReady: Promise<WasmModule> | null = null;

async function loadWasm(): Promise<WasmModule> {
  if (!wasmReady) {
    wasmReady = (async () => {
      // Dynamic import of the wasm-bindgen web glue (ESM). The worker is a
      // module worker, so import() resolves the static-asset URL at runtime.
      const mod = (await import(/* webpackIgnore: true */ GLUE_URL)) as WasmModule;
      await mod.default(WASM_URL);
      return mod;
    })();
  }
  return wasmReady;
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  try {
    const wasm = await loadWasm();
    if (msg.type === "prove") {
      const inputJson =
        typeof msg.input === "string" ? msg.input : JSON.stringify(msg.input);
      const result = wasm.prove(inputJson, msg.provingKeyHex);
      (self as DedicatedWorkerGlobalScope).postMessage({
        id: msg.id,
        ok: true,
        result,
      });
    } else if (msg.type === "verify") {
      const result = wasm.verify(msg.proofJson, msg.verifyingKeyHex);
      (self as DedicatedWorkerGlobalScope).postMessage({
        id: msg.id,
        ok: true,
        result,
      });
    } else if (msg.type === "warm") {
      // WASM is now instantiated (loadWasm above), ack so the caller knows the
      // worker is hot. No proving work done.
      void wasm;
      (self as DedicatedWorkerGlobalScope).postMessage({
        id: msg.id,
        ok: true,
        result: true,
      });
    } else {
      throw new Error(`unknown message type`);
    }
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      id: (msg as InMsg).id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export {};
