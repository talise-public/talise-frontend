/**
 * Talise shielded-pool SDK, trial-decrypt scanning.
 *
 * The recipient discovers incoming notes by fetching every emitted commitment
 * (+ its encrypted output ciphertext) from the indexer and trial-decrypting
 * each ciphertext with the viewing key. A successful decrypt whose recomputed
 * commitment matches the on-chain commitment is one of the recipient's notes.
 *
 * The commitments feed is served by `/api/shield/commitments` (owned by the
 * indexer/merkle agent, Workstream C). This module only CONSUMES it; the exact
 * row shape is defined defensively here and adjusted when that route lands.
 *
 * The `viewingKey: bigint` parameter is the recipient's ECIES enc private
 * scalar (see keys.ts `deriveShieldEncScalar` + encrypt.ts), the bigint key
 * that trial-decrypts the `encrypted_output` blobs.
 *
 * CRYPTO STATUS: note ENCRYPTION is REAL (P-256 ECIES + AES-256-GCM, see
 * encrypt.ts). The commitment recompute still uses the STUBBED Poseidon (see
 * keys.ts). The scan LOOP itself (fetch, paginate, match) is real.
 */

import { decryptNote } from "./encrypt";
import { noteCommitment, type SpendableNote } from "./note";

/** A commitment row as served by `/api/shield/commitments`. */
export type CommitmentRow = {
  /** Leaf index in the Merkle tree. */
  leafIndex: number;
  /** The on-chain commitment field element (decimal string for u256 safety). */
  commitment: string;
  /** The `encrypted_output` ciphertext for this leaf. May be 0x-hex (indexer
   *  array path) OR a base64 string (Sui JSON-RPC renders vector<u8> as base64
   *  on many fullnode versions) OR null (legacy/unindexed). decodeBlob handles all. */
  encryptedOutput: string | null;
};

export type ScanOptions = {
  /** Base URL for the commitments API. Default same-origin `/api/shield/commitments`. */
  baseUrl?: string;
  /** Custom fetch (tests / RN). Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Only scan leaves at/after this index (incremental rescan). Default 0. */
  fromLeafIndex?: number;
  /** Page size for the cursor fetch. Default 500. */
  pageSize?: number;
};

/**
 * Scan the commitments feed and return the notes that belong to `viewingKey`.
 * Pure consumer of the indexer, never signs, never holds spend authority.
 */
export async function scanNotes(
  viewingKey: bigint,
  opts: ScanOptions = {}
): Promise<SpendableNote[]> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? "/api/shield/commitments";
  // The route caps `limit` at 200; requesting more makes the "short page = done"
  // check misfire and stop after one page. Match the server cap exactly.
  const pageSize = Math.min(opts.pageSize ?? 200, 200);
  // The route's `after` cursor is EXCLUSIVE (leaf_index > after), so start one
  // below the desired first leaf.
  let after = (opts.fromLeafIndex ?? 0) - 1;

  const found: SpendableNote[] = [];

  // Bounded cursor walk: stop when a page returns fewer rows than requested.
  for (;;) {
    const url = `${baseUrl}?after=${after}&limit=${pageSize}`;
    const res = await doFetch(url);
    if (!res.ok) {
      throw new Error(`scan fetch failed: ${res.status}`);
    }
    // The route returns { items }; tolerate { commitments } for older shapes.
    const json = (await res.json()) as { items?: CommitmentRow[]; commitments?: CommitmentRow[] };
    const rows = json.items ?? json.commitments ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      // Per-row isolation: a single malformed/legacy row must NEVER abort the
      // whole scan (that silently disabled scan-first → re-deposit → strand).
      try {
        const note = await tryDecryptRow(row, viewingKey);
        if (note) found.push(note);
      } catch {
        /* skip this row, keep scanning */
      }
    }

    if (rows.length < pageSize) break;
    after = rows[rows.length - 1].leafIndex; // exclusive cursor
  }

  return found;
}

/**
 * Trial-decrypt one row. Returns the note iff (a) decrypt succeeds AND (b) the
 * recomputed commitment matches the on-chain commitment, the binding check
 * that turns a weak stub-decrypt accept into a real match.
 */
export async function tryDecryptRow(
  row: CommitmentRow,
  viewingKey: bigint
): Promise<SpendableNote | null> {
  const ct = decodeBlob(row.encryptedOutput);
  if (!ct) return null;
  const note = await decryptNote(ct, viewingKey);
  if (!note) return null;

  const recomputed = noteCommitment(note);
  let onchain: bigint;
  try {
    onchain = BigInt(row.commitment);
  } catch {
    return null;
  }
  if (recomputed !== onchain) return null;

  return { ...note, commitment: recomputed, leafIndex: row.leafIndex };
}

/**
 * Decode a `vector<u8>` blob to bytes. The on-chain `encrypted_output` reaches
 * us in MULTIPLE wire shapes depending on the fullnode/index path: `0x`-hex
 * (indexer array path), a base64 string (Sui JSON-RPC's vector<u8> rendering on
 * many fullnode versions, the shape that previously broke scan entirely), or
 * null. Tolerate all; the downstream 221-byte length gate + commitment match
 * reject anything that decodes to garbage, so being permissive here is safe.
 */
function decodeBlob(raw: string | null | undefined): Uint8Array | null {
  if (!raw || typeof raw !== "string") return null;
  const fromHex = (s: string): Uint8Array | null => {
    if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) return null;
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  };
  if (raw.startsWith("0x")) return fromHex(raw.slice(2));
  // Not 0x-prefixed → almost certainly the base64 JSON-RPC rendering. Try base64
  // first, then bare-hex as a last resort.
  try {
    const bin =
      typeof atob === "function"
        ? atob(raw)
        : // eslint-disable-next-line no-undef
          Buffer.from(raw, "base64").toString("binary");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    if (out.length > 0) return out;
  } catch {
    /* fall through */
  }
  return fromHex(raw);
}
