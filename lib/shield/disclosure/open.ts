/**
 * Talise shielded-pool, SELECTIVE DISCLOSURE — opening proofs.
 *
 * An OPENING PROOF is the cheapest useful disclosure primitive there is. The
 * note holder publishes the Poseidon preimage of a commitment that is already
 * on chain:
 *
 *     commitment = hash4(amount, pubkey, blinding, pool)          (already on chain)
 *     opening    = (amount, pubkey, blinding, pool)               (revealed now)
 *
 * A verifier recomputes `hash4` over the revealed tuple and compares it to the
 * commitment that the pool emitted in its `NewCommitment` event. If they match,
 * the opener knew the preimage, so a note of exactly that amount exists in that
 * pool at that leaf.
 *
 * ── Why this is the good part ──────────────────────────────────────────────
 *   • NO trusted setup. Nothing here touches Groth16, the proving key, or the
 *     ceremony. The only assumption is Poseidon-BN254 collision resistance,
 *     the same assumption the pool already rests on.
 *   • NO new on-chain verifier, no Move change, no gas. The commitment is
 *     already published; we are just supplying its preimage.
 *   • Verifiable by a stranger. `verifyOpeningLocally` needs no Talise service;
 *     `verify.ts` adds the chain anchor against any fullnode the verifier picks.
 *
 * ── What an opening does NOT prove ─────────────────────────────────────────
 *   • Not "unspent". The nullifier is `hash3(commitment, pathIndex, sig)` and
 *     `sig` binds the SPENDING key, which an opening never contains. So you
 *     cannot compute this note's nullifier from a receipt, and therefore cannot
 *     check the spent-set from a receipt alone. (See DISCLOSURE.md.)
 *   • Not "sent by X". `ExtData` carries no recipient and the pool has no
 *     sender field bound into the note. The tx `sender` is the RELAYER.
 *   • Not "owned by this human". `pubkey` is a field element. Binding it to a
 *     legal identity is an out-of-band claim (see DISCLOSURE.md).
 *
 * Pure, dependency-light, importable from a browser tab or plain Node.
 */

import { BN254_SCALAR_FIELD } from "../sdk/keys";
import { noteCommitment, type Note } from "../sdk/note";
import {
  DISCLOSURE_VERSION,
  NOTE_OPENING_KIND,
  formatBaseUnits,
  parseDecimal,
  type NoteLocator,
  type NoteOpening,
} from "./format";

/** u64 ceiling — the pool's public value leg is a `u64`, so amounts fit. */
const U64_MAX = (1n << 64n) - 1n;

/**
 * Normalise a Sui object id / address into the field element the note binds.
 * A Sui address is 32 bytes (up to 256 bits) while the BN254 scalar field is
 * ~254 bits, so `makeNote` reduces mod r. The verifier must reduce identically
 * or a perfectly good note looks forged.
 */
export function poolFieldFromAddress(addr: string): bigint {
  const hex = addr.trim().toLowerCase();
  if (!/^0x[0-9a-f]{1,64}$/.test(hex)) {
    throw new Error(`not a Sui address: ${addr}`);
  }
  return BigInt(hex) % BN254_SCALAR_FIELD;
}

export type BuildOpeningParams = {
  /** The note being opened, exactly as held in the wallet. */
  note: Note;
  /** Public on-chain coordinates for the note's commitment. */
  locator: NoteLocator;
  /** Decimals for display only (6 for USDsui). */
  amountDecimals: number;
  /** Optional reference the discloser attaches (invoice number, etc.). */
  memo?: string | null;
};

/**
 * Build the opening document for one note.
 *
 * DELIBERATE ACT: calling this reveals the note's blinding factor to whoever
 * receives the output. There is no "preview" mode that hides it — the blinding
 * IS the proof. Never call this on a user's behalf without an explicit,
 * per-note confirmation.
 *
 * Self-checking: it recomputes the commitment from the note and refuses to
 * build a document whose locator or fields are internally inconsistent, so a
 * receipt that leaves this function always verifies offline.
 */
export function buildNoteOpening(params: BuildOpeningParams): NoteOpening {
  const { note, locator } = params;

  for (const [label, v] of [
    ["amount", note.amount],
    ["pubkey", note.pubkey],
    ["blinding", note.blinding],
    ["pool", note.pool],
  ] as const) {
    if (v < 0n || v >= BN254_SCALAR_FIELD) {
      throw new Error(`buildNoteOpening: ${label} outside the BN254 scalar field`);
    }
  }
  if (note.amount > U64_MAX) {
    throw new Error("buildNoteOpening: amount exceeds u64");
  }
  if (!Number.isInteger(locator.leafIndex) || locator.leafIndex < 0) {
    throw new Error("buildNoteOpening: leafIndex must be a non-negative integer");
  }
  const expectedPool = poolFieldFromAddress(locator.poolObjectId);
  if (note.pool !== expectedPool) {
    throw new Error(
      "buildNoteOpening: note.pool does not match locator.poolObjectId " +
        "(the note belongs to a different pool)"
    );
  }
  if (!Number.isInteger(params.amountDecimals) || params.amountDecimals < 0 || params.amountDecimals > 18) {
    throw new Error("buildNoteOpening: amountDecimals must be an integer in [0,18]");
  }

  return {
    kind: NOTE_OPENING_KIND,
    version: DISCLOSURE_VERSION,
    commitment: noteCommitment(note).toString(),
    note: {
      amount: note.amount.toString(),
      pubkey: note.pubkey.toString(),
      blinding: note.blinding.toString(),
      pool: note.pool.toString(),
    },
    locator: {
      coinType: locator.coinType,
      packageId: locator.packageId,
      poolObjectId: locator.poolObjectId,
      leafIndex: locator.leafIndex,
      txDigest: locator.txDigest ?? null,
    },
    amountDecimals: params.amountDecimals,
    memo: params.memo ?? null,
  };
}

/**
 * Strictly parse an untrusted opening document into typed values. Throws with a
 * precise reason on anything malformed — a verifier should never coerce.
 */
export function parseNoteOpening(raw: unknown): {
  note: Note;
  commitment: bigint;
  locator: NoteLocator;
  amountDecimals: number;
  memo: string | null;
} {
  if (!raw || typeof raw !== "object") throw new Error("opening: not an object");
  const o = raw as Record<string, unknown>;
  if (o.kind !== NOTE_OPENING_KIND) {
    throw new Error(`opening: wrong kind (${String(o.kind)})`);
  }
  if (o.version !== DISCLOSURE_VERSION) {
    throw new Error(`opening: unsupported version (${String(o.version)})`);
  }
  const n = o.note;
  if (!n || typeof n !== "object") throw new Error("opening: missing note");
  const nf = n as Record<string, unknown>;
  const note: Note = {
    amount: parseDecimal(nf.amount, "opening.note.amount"),
    pubkey: parseDecimal(nf.pubkey, "opening.note.pubkey"),
    blinding: parseDecimal(nf.blinding, "opening.note.blinding"),
    pool: parseDecimal(nf.pool, "opening.note.pool"),
  };
  const commitment = parseDecimal(o.commitment, "opening.commitment");

  const l = o.locator;
  if (!l || typeof l !== "object") throw new Error("opening: missing locator");
  const lf = l as Record<string, unknown>;
  const str = (k: string): string => {
    const v = lf[k];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`opening.locator.${k}: expected a non-empty string`);
    }
    return v;
  };
  const leafIndex = lf.leafIndex;
  if (typeof leafIndex !== "number" || !Number.isInteger(leafIndex) || leafIndex < 0) {
    throw new Error("opening.locator.leafIndex: expected a non-negative integer");
  }
  const txDigest = lf.txDigest;
  if (txDigest !== null && typeof txDigest !== "string") {
    throw new Error("opening.locator.txDigest: expected a string or null");
  }
  const amountDecimals = o.amountDecimals;
  if (
    typeof amountDecimals !== "number" ||
    !Number.isInteger(amountDecimals) ||
    amountDecimals < 0 ||
    amountDecimals > 18
  ) {
    throw new Error("opening.amountDecimals: expected an integer in [0,18]");
  }
  const memo = o.memo;
  if (memo !== null && typeof memo !== "string") {
    throw new Error("opening.memo: expected a string or null");
  }

  return {
    note,
    commitment,
    locator: {
      coinType: str("coinType"),
      packageId: str("packageId"),
      poolObjectId: str("poolObjectId"),
      leafIndex,
      txDigest: (txDigest as string | null) ?? null,
    },
    amountDecimals,
    memo: (memo as string | null) ?? null,
  };
}

export type LocalOpeningCheck = {
  ok: boolean;
  /** Every failed check, in evaluation order. Empty iff `ok`. */
  errors: string[];
  /** The recomputed commitment, present whenever the document parsed. */
  recomputedCommitment: string | null;
  /** Parsed values, present whenever the document parsed. */
  parsed: ReturnType<typeof parseNoteOpening> | null;
};

/**
 * THE opening check, offline. No network, no Talise, no verifying key:
 *
 *   1. the document parses strictly,
 *   2. every field is inside the BN254 scalar field and the amount inside u64,
 *   3. `hash4(amount, pubkey, blinding, pool) == commitment`,
 *   4. `pool == poolObjectId mod r` (the note is bound to the named pool).
 *
 * Passing (1–4) means the tuple is a genuine preimage of `commitment`. It does
 * NOT yet mean `commitment` is on chain — that is `verify.ts`'s chain anchor,
 * and without it a forger could invent a self-consistent note out of thin air.
 * Both halves are required; neither alone is a disclosure.
 */
export function verifyOpeningLocally(raw: unknown): LocalOpeningCheck {
  const errors: string[] = [];
  let parsed: ReturnType<typeof parseNoteOpening> | null = null;
  try {
    parsed = parseNoteOpening(raw);
  } catch (e) {
    return {
      ok: false,
      errors: [(e as Error).message],
      recomputedCommitment: null,
      parsed: null,
    };
  }

  const { note, commitment, locator } = parsed;

  for (const [label, v] of [
    ["amount", note.amount],
    ["pubkey", note.pubkey],
    ["blinding", note.blinding],
    ["pool", note.pool],
  ] as const) {
    if (v >= BN254_SCALAR_FIELD) {
      errors.push(`note.${label} is not a BN254 field element`);
    }
  }
  if (note.amount > U64_MAX) errors.push("note.amount exceeds u64");
  if (commitment >= BN254_SCALAR_FIELD) {
    errors.push("commitment is not a BN254 field element");
  }

  let recomputed: bigint | null = null;
  if (errors.length === 0) {
    recomputed = noteCommitment(note);
    if (recomputed !== commitment) {
      errors.push(
        "commitment mismatch: hash4(amount, pubkey, blinding, pool) != commitment " +
          "(the opening does not open this commitment)"
      );
    }
  }

  try {
    const expected = poolFieldFromAddress(locator.poolObjectId);
    if (note.pool !== expected) {
      errors.push("note.pool does not match locator.poolObjectId");
    }
  } catch (e) {
    errors.push(`locator.poolObjectId: ${(e as Error).message}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    recomputedCommitment: recomputed?.toString() ?? null,
    parsed,
  };
}

/**
 * The one-line human claim for an opening. Deterministic (built purely from the
 * document) so it cannot say something the fields do not. Structurally typed so
 * both a full {@link NoteOpening} and a verifier's re-parsed view fit.
 */
export function openingStatement(opening: {
  note: { amount: string };
  locator: NoteLocator;
  amountDecimals: number;
}): string {
  const amount = formatBaseUnits(BigInt(opening.note.amount), opening.amountDecimals);
  const asset = opening.locator.coinType.split("::").pop() ?? opening.locator.coinType;
  const where = `leaf ${opening.locator.leafIndex} of shielded pool ${opening.locator.poolObjectId}`;
  const anchor = opening.locator.txDigest
    ? ` created by transaction ${opening.locator.txDigest}`
    : " (no transaction digest supplied, so this opening cannot be anchored on chain)";
  return `A shielded note of ${amount} ${asset} exists at ${where}${anchor}.`;
}
