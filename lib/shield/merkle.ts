import "server-only";

import { poseidonHash } from "@mysten/sui/zklogin";
import { db } from "@/lib/db";
import { ensureShieldSchema, maxLeafIndex, type ShieldMerkleCacheRow } from "@/lib/shield/db";
import { memoTtl } from "@/lib/perf-cache";

/**
 * Talise shielded-pool — incremental height-26 Merkle tree + path service
 * (Workstream C).
 *
 * Pure-TS port of `move/talise-privacy/sources/merkle.move`. The two MUST agree
 * leaf-for-leaf and root-for-root (the Phase-0 gate: Rust-root == Move-root ==
 * this TS-root); otherwise no deposit is ever spendable.
 *
 * THE Poseidon (the make-or-break detail): `poseidon2(a,b)` here is
 * `@mysten/sui/zklogin`'s `poseidonHash([a,b])`, which is the circomlib /
 * `poseidon-lite` BN254 Poseidon — byte-identical to `sui::poseidon_bn254`.
 * This is VERIFIED, not stubbed: the on-chain `empty_subtree_hashes` recurrence
 * `H[i] = poseidon2(H[i-1], H[i-1])` reproduces the committed constants exactly
 * (see EMPTY_SUBTREE_HASHES below + the constants.move source). `@mysten/sui` is
 * a direct dependency, so this adds no new npm dep.
 *
 * Tree shape (verbatim from merkle.move):
 *   - leaves are the commitments themselves (NO per-leaf hash); they are
 *     appended in PAIRS (two per `transact`), so the bottom level is
 *     pre-combined with one poseidon2(c0,c1) and the walk up starts at level 1.
 *   - a dummy / empty leaf has value ZERO_VALUE (== EMPTY_SUBTREE_HASHES[0]).
 *   - height 26 → 2^26 ≈ 67M leaf capacity.
 */

export const HEIGHT = 26;

/**
 * The all-ZERO leaf value. This is the Tornado-Nova / Vortex ZERO_VALUE
 * (keccak("tornado") mod p), which is exactly `empty_subtree_hashes[0]` in
 * constants.move — the leaf-level entry of the empty-subtree series. A dummy
 * (unused) input note uses this as its leaf and an all-ZERO path.
 */
export const ZERO_VALUE =
  18688842432741139442778047327644092677418528270738216181718229581494125774932n;

/**
 * BN254 scalar field modulus — every leaf / node must be a field element.
 * Mirrors `constants::bn254_field_modulus!()`.
 */
export const BN254_FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Precomputed empty-subtree hashes (HEIGHT+1 = 27 entries), copied verbatim
 * from `constants.move::empty_subtree_hashes!()`. index 0 = ZERO_VALUE leaf;
 * index i = poseidon2(H[i-1], H[i-1]); index 26 = the empty-tree root.
 *
 * These are DERIVED, not arbitrary: `rederiveEmptySubtreeHashes()` recomputes
 * them from ZERO_VALUE via this module's poseidon2 and asserts equality — the
 * TS-side half of the Poseidon byte-match gate.
 */
export const EMPTY_SUBTREE_HASHES: readonly bigint[] = [
  18688842432741139442778047327644092677418528270738216181718229581494125774932n,
  929670100605127589096201729966801143828059989180770638007278601230757123028n,
  20059153686521406362481271315473498068253845102360114882796737328118528819600n,
  667276972495892769517195136104358636854444397700904910347259067486374491460n,
  12333205860481369973758777121486440301866097422034925170601892818077919669856n,
  13265906118204670164732063746425660672195834675096811019428798251172285860978n,
  3254533810100792365765975246297999341668420141674816325048742255119776645299n,
  18309808253444361227126414342398728022042151803316641228967342967902364963927n,
  12126650299593052178871547753567584772895820192048806970138326036720774331291n,
  9949817351285988369728267498508465715570337443235086859122087250007803517342n,
  11208526958197959509185914785003803401681281543885952782991980697855275912368n,
  59685738145310886711325295148553591612803302297715439999772116453982910402n,
  20837058910394942465479261789141487609029093821244922450759151002393360448717n,
  8209451842087447702442792222326370366485985268583914555249981462794434142285n,
  19651337661238139284113069695072175498780734789512991455990330919229086149402n,
  11527931080332651861006914960138009072130600556413592683110711451245237795573n,
  20764556403192106825184782309105498322242675071639346714780565918367449744227n,
  10818178251908058160377157228631396071771716850372988172358158281935915764080n,
  21598305620835755437985090087223184201582363356396834169567261294737143234327n,
  16481295130402928965223624965091828506529631770925981912487987233811901391354n,
  17911512007742433173433956238979622028159186641781974955249650899638270671335n,
  5186032540459307640178997905000265487821097518169449170073506338735292796958n,
  19685513117592528774434273738957742787082069361009067298107167967352389473358n,
  10912258653908058948673432107359060806004349811796220228800269957283778663923n,
  19880031465088514794850462701773174075421406509504511537647395867323147191667n,
  18344394662872801094289264994998928886741543433797415760903591256277307773470n,
  4023688209857926016730691838838984168964497755397275208674494663143007853450n,
];

/**
 * poseidon2(a, b) == `sui::poseidon::poseidon_bn254(&vector[a, b])`.
 *
 * Backed by `@mysten/sui/zklogin`'s `poseidonHash`, which wraps the
 * `poseidon-lite` circomlib BN254 Poseidon. NOT a stub — verified
 * byte-identical to the on-chain hash (see module doc + `selfTest()`).
 */
export function poseidon2(a: bigint, b: bigint): bigint {
  return poseidonHash([a, b]);
}

function assertField(x: bigint, label: string): void {
  if (x < 0n || x >= BN254_FIELD_MODULUS) {
    throw new Error(`${label} not in the BN254 field: ${x}`);
  }
}

/**
 * Self-test of the Poseidon byte-match: re-derive every EMPTY_SUBTREE_HASHES
 * entry from ZERO_VALUE and confirm it equals the committed (on-chain)
 * constant. Returns the recomputed series; throws on the first mismatch. This
 * is the TS half of the Phase-0 Rust-root == Move-root == TS-root gate and is
 * the unit test the build plan asks for (kept inline so a route or a script
 * can assert it without a test runner).
 */
export function rederiveEmptySubtreeHashes(): bigint[] {
  const out: bigint[] = [ZERO_VALUE];
  for (let i = 1; i <= HEIGHT; i++) {
    out.push(poseidon2(out[i - 1], out[i - 1]));
  }
  for (let i = 0; i <= HEIGHT; i++) {
    if (out[i] !== EMPTY_SUBTREE_HASHES[i]) {
      throw new Error(
        `Poseidon mismatch at empty-subtree level ${i}: derived ${out[i]} != committed ${EMPTY_SUBTREE_HASHES[i]}`
      );
    }
  }
  return out;
}

/** True iff this module's Poseidon matches the on-chain constants. */
export function selfTest(): boolean {
  try {
    rederiveEmptySubtreeHashes();
    return true;
  } catch {
    return false;
  }
}

// ── Incremental tree (mirror of merkle.move's frontier walk) ─────────────

/**
 * Serializable frontier state. `subtrees[i]` is the cached left-sibling hash
 * at level i (exactly `MerkleTree.subtrees` on chain); `nextIndex` is the next
 * leaf slot (always even — leaves go in pairs). `root` is the current root.
 */
export interface TreeState {
  nextIndex: number;
  subtrees: string[]; // u256 decimal strings, length HEIGHT
  root: string; // u256 decimal string
}

/** Fresh empty tree — seeds the frontier from EMPTY_SUBTREE_HASHES, root at top. */
export function emptyTree(): TreeState {
  const subtrees: string[] = [];
  for (let i = 0; i < HEIGHT; i++) subtrees.push(EMPTY_SUBTREE_HASHES[i].toString());
  return {
    nextIndex: 0,
    subtrees,
    root: EMPTY_SUBTREE_HASHES[HEIGHT].toString(),
  };
}

/**
 * Append two commitments — line-for-line the same frontier walk as
 * `merkle.move::append_pair`. Mutates and returns `state`.
 */
export function appendPair(state: TreeState, commitment0: bigint, commitment1: bigint): TreeState {
  assertField(commitment0, "commitment0");
  assertField(commitment1, "commitment1");
  if (1 * 2 ** HEIGHT <= state.nextIndex) {
    throw new Error("merkle tree overflow");
  }

  const subtrees = state.subtrees.map((s) => BigInt(s));
  let currentIndex = Math.floor(state.nextIndex / 2);
  let currentLevelHash = poseidon2(commitment0, commitment1);

  // Walk levels 1..HEIGHT, folding in the cached frontier.
  for (let i = 1; i < HEIGHT; i++) {
    let left: bigint;
    let right: bigint;
    if (currentIndex % 2 === 0) {
      // left child: cache ourselves, pair with the empty sibling.
      left = currentLevelHash;
      right = EMPTY_SUBTREE_HASHES[i];
      subtrees[i] = currentLevelHash;
    } else {
      // right child: pair with the cached left sibling.
      left = subtrees[i];
      right = currentLevelHash;
    }
    currentLevelHash = poseidon2(left, right);
    currentIndex = Math.floor(currentIndex / 2);
  }

  state.subtrees = subtrees.map((s) => s.toString());
  state.root = currentLevelHash.toString();
  state.nextIndex = state.nextIndex + 2;
  return state;
}

// ── Full tree rebuild + authentication path ──────────────────────────────

/**
 * Rebuild the FULL level-0..HEIGHT node arrays from the ordered leaf list.
 * Unused right-hand slots at each level are filled with the empty-subtree
 * hash for that level, exactly as the on-chain tree implies. Returns
 * `{ levels, root }` where `levels[0]` are the leaves (padded to even).
 *
 * O(n) in the number of populated leaves — fine for the path service, which
 * runs off the hot money path and is memoized.
 */
export function buildLevels(leaves: bigint[]): { levels: bigint[][]; root: bigint } {
  // Pad to an even leaf count with ZERO_VALUE so pairs are well-defined.
  const level0 = leaves.slice();
  if (level0.length % 2 === 1) level0.push(ZERO_VALUE);

  const levels: bigint[][] = [level0];
  for (let lvl = 0; lvl < HEIGHT; lvl++) {
    const cur = levels[lvl];
    const next: bigint[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const left = cur[i];
      const right = i + 1 < cur.length ? cur[i + 1] : EMPTY_SUBTREE_HASHES[lvl];
      next.push(poseidon2(left, right));
    }
    if (next.length === 0) next.push(EMPTY_SUBTREE_HASHES[lvl + 1]);
    if (next.length % 2 === 1 && lvl + 1 < HEIGHT) next.push(EMPTY_SUBTREE_HASHES[lvl + 1]);
    levels.push(next);
  }
  return { levels, root: levels[HEIGHT][0] };
}

/**
 * A single path step in the WASM prover's format: `[left, right]` u256 decimal
 * strings, where one of the two is the running subtree hash and the other is
 * the sibling. The verifier recomputes `poseidon2(left, right)` up the tree.
 */
export type PathPair = [string, string];

export interface MerklePath {
  /** The leaf this path authenticates (u256 decimal string). */
  leaf: string;
  /** 0-based leaf index. */
  leafIndex: number;
  /** Exactly HEIGHT `[left,right]` pairs, bottom level first. */
  pathPairs: PathPair[];
  /** Per-level 0/1 position bit (0 = node is the left input). */
  pathIndices: number[];
  /** The root these pairs fold up to. */
  root: string;
}

/**
 * Compute the HEIGHT `[left,right]` pairs that authenticate `leafIndex`
 * against the rebuilt tree. The running hash starts as the leaf and, at each
 * level, is placed on the left or right per the index bit, paired with its
 * sibling (an empty-subtree hash when the sibling slot is unfilled).
 */
export function pathFor(leaves: bigint[], leafIndex: number): MerklePath {
  if (leafIndex < 0) throw new Error("leafIndex must be >= 0");
  const { levels, root } = buildLevels(leaves);

  const leaf = leafIndex < levels[0].length ? levels[0][leafIndex] : ZERO_VALUE;

  const pathPairs: PathPair[] = [];
  const pathIndices: number[] = [];
  let idx = leafIndex;
  let node = leaf;

  for (let lvl = 0; lvl < HEIGHT; lvl++) {
    const cur = levels[lvl];
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    const sibling =
      siblingIdx < cur.length ? cur[siblingIdx] : EMPTY_SUBTREE_HASHES[lvl];

    const left = isRight ? sibling : node;
    const right = isRight ? node : sibling;
    pathPairs.push([left.toString(), right.toString()]);
    pathIndices.push(isRight ? 1 : 0);

    node = poseidon2(left, right);
    idx = Math.floor(idx / 2);
  }

  return {
    leaf: leaf.toString(),
    leafIndex,
    pathPairs,
    pathIndices,
    root: root.toString(),
  };
}

/** An all-ZERO path for a dummy input note (unused 2-in slot). */
export function dummyPath(): MerklePath {
  const pathPairs: PathPair[] = [];
  const pathIndices: number[] = [];
  let node = ZERO_VALUE;
  for (let lvl = 0; lvl < HEIGHT; lvl++) {
    const sibling = EMPTY_SUBTREE_HASHES[lvl];
    pathPairs.push([node.toString(), sibling.toString()]);
    pathIndices.push(0);
    node = poseidon2(node, sibling);
  }
  return {
    leaf: ZERO_VALUE.toString(),
    leafIndex: 0,
    pathPairs,
    pathIndices,
    root: node.toString(),
  };
}

// ── Postgres-cached tree + path service ───────────────────────────────────

/** Ordered leaf list (commitments) for a coin type, lowest index first. */
async function loadLeaves(coinType: string): Promise<bigint[]> {
  await ensureShieldSchema();
  const r = await db().execute({
    sql: `SELECT leaf_index, commitment FROM shield_commitments
          WHERE coin_type = ? ORDER BY leaf_index ASC`,
    args: [coinType],
  });
  const leaves: bigint[] = [];
  for (const row of r.rows as Array<{ leaf_index: number; commitment: string }>) {
    // Defensive: leaves must be contiguous from 0 for the tree to be valid.
    leaves[row.leaf_index] = BigInt(row.commitment);
  }
  // Fill any gap with ZERO_VALUE (should not happen with a healthy indexer).
  for (let i = 0; i < leaves.length; i++) {
    if (leaves[i] === undefined) leaves[i] = ZERO_VALUE;
  }
  return leaves;
}

/**
 * Read the cached merkle state for a coin type (if any). Used as a fast root /
 * last-index source; the path service still rebuilds levels from leaves (the
 * frontier alone can't produce arbitrary sibling paths).
 */
export async function getCachedTree(coinType: string): Promise<ShieldMerkleCacheRow | null> {
  await ensureShieldSchema();
  const r = await db().execute({
    sql: `SELECT coin_type, tree_state, last_index, root, updated_at
          FROM shield_merkle_cache WHERE coin_type = ? LIMIT 1`,
    args: [coinType],
  });
  return (r.rows[0] as unknown as ShieldMerkleCacheRow | undefined) ?? null;
}

/**
 * Recompute the frontier from all leaves and upsert it into
 * shield_merkle_cache. Called by the indexer after a batch lands. Returns the
 * fresh root.
 */
export async function refreshMerkleCache(coinType: string): Promise<string> {
  await ensureShieldSchema();
  const leaves = await loadLeaves(coinType);

  const state = emptyTree();
  for (let i = 0; i < leaves.length; i += 2) {
    const c0 = leaves[i] ?? ZERO_VALUE;
    const c1 = leaves[i + 1] ?? ZERO_VALUE;
    appendPair(state, c0, c1);
  }
  const lastIndex = leaves.length - 1;

  await db().execute({
    sql: `INSERT INTO shield_merkle_cache (coin_type, tree_state, last_index, root, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (coin_type) DO UPDATE SET
            tree_state = EXCLUDED.tree_state,
            last_index = EXCLUDED.last_index,
            root = EXCLUDED.root,
            updated_at = EXCLUDED.updated_at`,
    args: [coinType, JSON.stringify(state), lastIndex, state.root, Date.now()],
  });
  return state.root;
}

/**
 * Serve the authentication path for a leaf in the WASM-prover format. The
 * leaf may be given by index OR by commitment value; passing the commitment
 * lets the prover validate the indexer agrees on its placement. Memoized
 * (`memoTtl`, 10s) keyed by (coinType, leafIndex) since the tree only grows.
 *
 * Throws when the commitment doesn't match the leaf at that index — a
 * load-bearing validation: a wrong leaf yields an unspendable proof.
 */
export async function merklePathForLeaf(
  coinType: string,
  opts: { leafIndex?: number; commitment?: bigint }
): Promise<MerklePath> {
  await ensureShieldSchema();
  const leaves = await loadLeaves(coinType);

  let leafIndex = opts.leafIndex;
  if (leafIndex === undefined && opts.commitment !== undefined) {
    leafIndex = leaves.findIndex((l) => l === opts.commitment);
    if (leafIndex < 0) {
      throw new Error("commitment not found in the indexed tree");
    }
  }
  if (leafIndex === undefined) {
    throw new Error("merklePathForLeaf requires leafIndex or commitment");
  }
  if (leafIndex >= leaves.length) {
    throw new Error(`leafIndex ${leafIndex} out of range (have ${leaves.length} leaves)`);
  }

  // Leaf validation: the supplied commitment must match what we indexed.
  if (opts.commitment !== undefined && leaves[leafIndex] !== opts.commitment) {
    throw new Error(
      `commitment mismatch at leaf ${leafIndex}: indexed ${leaves[leafIndex]} != requested ${opts.commitment}`
    );
  }

  // Pair-partner guard: on-chain `append_pair` writes BOTH leaves of a pair, and
  // a real commitment is NEVER ZERO_VALUE. If the partner is missing/gap-filled,
  // the deposit's odd leaf hasn't indexed yet — serving a path now would fold the
  // even leaf against a ZERO_VALUE sibling, yielding a root that never existed
  // on-chain → an unspendable proof that aborts the withdraw. Make the caller
  // keep polling until the whole pair is indexed.
  const partner = leafIndex ^ 1;
  if (partner >= leaves.length || leaves[partner] === ZERO_VALUE) {
    throw new Error("pair-partner not indexed yet — still indexing");
  }

  return memoTtl(`shield-path:${coinType}:${leafIndex}:${leaves.length}`, 10_000, async () =>
    pathFor(leaves, leafIndex!)
  );
}

/** Current root for a coin type, recomputed from leaves (memoized 10s). */
export async function currentRoot(coinType: string): Promise<string> {
  return memoTtl(`shield-root:${coinType}`, 10_000, async () => {
    const leaves = await loadLeaves(coinType);
    const state = emptyTree();
    for (let i = 0; i < leaves.length; i += 2) {
      appendPair(state, leaves[i] ?? ZERO_VALUE, leaves[i + 1] ?? ZERO_VALUE);
    }
    return state.root;
  });
}
