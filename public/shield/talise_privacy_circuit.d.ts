/* tslint:disable */
/* eslint-disable */

/**
 * Deserialize the compressed proving key ONCE and keep it. Time this call to
 * get the one-off stage-2 cost.
 */
export function bench_cache_pk(proving_key_hex: string): number;

/**
 * Stage 2 as `prove()` does it today: hex-decode + compressed deserialize with
 * full validation. Returns the key's point count.
 */
export function bench_load_pk_compressed(proving_key_hex: string): number;

/**
 * Same, skipping subgroup validation. Isolates how much of stage 2 is the
 * subgroup check versus the point decompression.
 */
export function bench_load_pk_compressed_unchecked(proving_key_hex: string): number;

/**
 * Stage 2 if the key were served UNCOMPRESSED. Expects hex of an
 * arkworks-uncompressed proving key (see `bench_recompress_pk_uncompressed`).
 */
export function bench_load_pk_uncompressed(proving_key_hex: string): number;

/**
 * Prove a representative deposit against the cached key — stages 3 + 4 only,
 * no key reload. Returns the same JSON shape as `wasm::prove`, so
 * `wasm::verify` can check it.
 */
export function bench_prove_deposit_cached(amount: bigint, out0: bigint, out1: bigint): string;

/**
 * One-shot converter so the benchmark can produce an uncompressed key in the
 * browser without a new build asset: compressed hex in, uncompressed hex out.
 * This is a measurement convenience, NOT how a real deployment should do it —
 * a real deployment would ship the uncompressed key as the static asset.
 */
export function bench_recompress_pk_uncompressed(proving_key_hex: string): string;

/**
 * Build a valid DEPOSIT [`ProofInput`] JSON for a pool, without the caller
 * having to reimplement Poseidon in JS. Mirrors the native
 * `prover::build_deposit_circuit_for_pool`: dummy (zero) input notes + two
 * fresh output notes summing to `amount`, `hashed_account_secret == 0`.
 *
 * * `pool_hex`  — 0x-prefixed Sui pool address (bound into `vortex`).
 * * `root_dec`  — Merkle root as a u256 decimal string (commonly "0" for deposit).
 * * `amount`    — total deposit amount (== public_value).
 * * `out0`,`out1` — output split; MUST sum to `amount`.
 *
 * Returns the JSON to feed straight into [`prove`]. This is the deposit-leg
 * witness assembler; withdraw/internal-transfer witnesses (real input notes +
 * Merkle paths) are assembled by the SDK and passed to [`prove`] directly.
 */
export function build_deposit_input(pool_hex: string, root_dec: string, amount: bigint, out0: bigint, out1: bigint): string;

/**
 * Set the panic hook once so Rust panics surface as readable console errors.
 */
export function main(): void;

/**
 * Generate a Groth16 proof in the browser.
 *
 * * `input_json`       — JSON-serialized [`ProofInput`].
 * * `proving_key_hex`  — hex of the arkworks compressed proving key
 *                        (`keys/proving_key.bin`).
 *
 * Returns JSON-serialized [`ProofOutput`].
 */
export function prove(input_json: string, proving_key_hex: string): string;

/**
 * Verify a proof in-wasm against a verifying key. Useful for a self-check
 * before submitting to chain, and for the test harness.
 *
 * * `proof_json`         — JSON-serialized [`ProofOutput`] from [`prove`].
 * * `verifying_key_hex`  — hex of the arkworks compressed verifying key
 *                          (`keys/verifying_key.bin` / `vk_sui.hex`).
 */
export function verify(proof_json: string, verifying_key_hex: string): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly bench_cache_pk: (a: number, b: number) => [number, number, number];
    readonly bench_load_pk_compressed: (a: number, b: number) => [number, number, number];
    readonly bench_load_pk_compressed_unchecked: (a: number, b: number) => [number, number, number];
    readonly bench_load_pk_uncompressed: (a: number, b: number) => [number, number, number];
    readonly bench_prove_deposit_cached: (a: bigint, b: bigint, c: bigint) => [number, number, number, number];
    readonly bench_recompress_pk_uncompressed: (a: number, b: number) => [number, number, number, number];
    readonly build_deposit_input: (a: number, b: number, c: number, d: number, e: bigint, f: bigint, g: bigint) => [number, number, number, number];
    readonly prove: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly verify: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly main: () => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
