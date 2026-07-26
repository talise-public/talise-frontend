/**
 * Talise shielded-pool, SELECTIVE DISCLOSURE — wire format + canonicalisation.
 *
 * Three JSON documents, all versioned and all self-describing:
 *
 *   talise.shield.note-opening/1        one note, opened. The atom.
 *   talise.shield.disclosure-receipt/1  a signed-off bundle of openings, the
 *                                       artefact you hand an auditor.
 *   talise.shield.viewing-grant/1       scoped READ access (see viewing-key.ts).
 *
 * Everything is plain JSON with every field element as a DECIMAL STRING (u256
 * does not survive a JS number), so the documents are readable, diffable, and
 * verifiable by a third party with nothing but a Poseidon implementation and a
 * Sui fullnode. There is no Talise-specific signature anywhere in the format:
 * the binding is the on-chain commitment, not our word.
 *
 * ── What lives here ────────────────────────────────────────────────────────
 *   • the document types,
 *   • `canonicalJson`, a deterministic serialisation (sorted keys, no space)
 *     so a receipt has ONE digest regardless of who serialised it,
 *   • `documentDigest`, SHA-256 over the canonical bytes,
 *   • `assertNoSecretLeak`, a hard guard that refuses to serialise a document
 *     carrying a spending key / note master / seed. See viewing-key.ts.
 *
 * NO server-only imports, NO Node-only deps: this file must be importable by an
 * independent verifier running under plain Node or in a browser tab.
 */

export const NOTE_OPENING_KIND = "talise.shield.note-opening" as const;
export const DISCLOSURE_RECEIPT_KIND = "talise.shield.disclosure-receipt" as const;
export const VIEWING_GRANT_KIND = "talise.shield.viewing-grant" as const;

/** Format version. Bump on ANY breaking field change. */
export const DISCLOSURE_VERSION = 1 as const;

/**
 * Where the disclosed note lives on chain. Every field is PUBLIC data that
 * anyone can already read; nothing here is secret.
 *
 *   coinType     , the pool's `CoinType` type tag (which asset the note holds).
 *   packageId    , the published `talise_privacy` package (pins the event type).
 *   poolObjectId , the `ShieldedPool<CoinType>` shared object.
 *   leafIndex    , the note's Merkle leaf index == `NewCommitment.index`.
 *   txDigest     , the transaction that emitted the commitment. REQUIRED for a
 *                  chain-verified result; null degrades to "cryptographically
 *                  consistent but not anchored" (see verify.ts).
 */
export type NoteLocator = {
  coinType: string;
  packageId: string;
  poolObjectId: string;
  leafIndex: number;
  txDigest: string | null;
};

/** The opened note preimage. `blinding` is the secret being burned. */
export type OpenedNoteFields = {
  /** Base-unit amount as a decimal string (e.g. USDsui micros). */
  amount: string;
  /** Owner pubkey field element, decimal. */
  pubkey: string;
  /** Per-note blinding factor, decimal. REVEALING THIS IS IRREVERSIBLE. */
  blinding: string;
  /** Pool binding field element, decimal (the pool address reduced mod r). */
  pool: string;
};

/**
 * ONE note, opened. Proves (once chain-checked) that a note of exactly
 * `note.amount` units of `locator.coinType`, owned by `note.pubkey`, exists as
 * leaf `locator.leafIndex` of pool `locator.poolObjectId`.
 *
 * The proof is the Poseidon preimage: `commitment` is on chain already, and
 * `hash4(amount, pubkey, blinding, pool)` reproduces it. Collision resistance
 * of Poseidon is the only cryptographic assumption — there is no trusted setup
 * and no verifying key involved.
 */
export type NoteOpening = {
  kind: typeof NOTE_OPENING_KIND;
  version: typeof DISCLOSURE_VERSION;
  /** The on-chain commitment, decimal string. */
  commitment: string;
  note: OpenedNoteFields;
  locator: NoteLocator;
  /** Decimals for rendering `note.amount` (6 for USDsui). Cosmetic only. */
  amountDecimals: number;
  /** Free-text reference the discloser attaches (invoice no., etc.). */
  memo: string | null;
};

/**
 * What a disclosure covers. Used by BOTH a receipt (where it describes the
 * bundle) and a viewing grant (where it bounds what the grantee may read).
 *
 * How strongly a scope binds depends on where it is used, and the difference
 * matters enough to spell out:
 *
 *   • In a SEALED grant / a receipt: the scope is EXACT, because the document
 *     physically contains only the in-scope notes. Nothing else is derivable.
 *   • In a DELEGATED-KEY grant: the scope is ADVISORY. It is enforced by
 *     Talise's API and by this SDK's `viewNotesWithGrant`, but a grantee
 *     holding the raw viewing key can decrypt anything they can fetch. Treat a
 *     delegated key as account-wide in your threat model. See DISCLOSURE.md.
 *
 * A verifier must never upgrade a scope into a proof of completeness: no scope
 * proves that the notes NOT shown do not exist.
 */
export type DisclosureScope =
  /** Exactly these commitments (decimal strings). */
  | { type: "notes"; commitments: string[] }
  /** Every note created by these transactions. */
  | { type: "transaction"; txDigests: string[] }
  /** Every note whose leaf index is in [fromLeafIndex, toLeafIndex]. */
  | { type: "leafRange"; fromLeafIndex: number; toLeafIndex: number }
  /** Every note created in [fromMs, toMs] (inclusive), by chain timestamp. */
  | { type: "dateRange"; fromMs: number; toMs: number }
  /** The whole account, past AND future. The widest grant there is. */
  | { type: "account" };

/** A commitment-feed row, as much of it as scope evaluation needs. */
export type ScopeCandidate = {
  leafIndex: number;
  commitment: string;
  txDigest?: string | null;
  createdAtMs?: number | null;
};

/**
 * Is a candidate note inside a scope? FAILS CLOSED: when the scope needs a
 * field the candidate does not carry (a `dateRange` against a row with no
 * timestamp, a `transaction` scope against a row with no digest), the answer is
 * `false`. A scope that cannot be evaluated must never widen.
 */
export function scopeIncludes(scope: DisclosureScope, row: ScopeCandidate): boolean {
  switch (scope.type) {
    case "account":
      return true;
    case "notes":
      return scope.commitments.includes(row.commitment);
    case "transaction":
      return !!row.txDigest && scope.txDigests.includes(row.txDigest);
    case "leafRange":
      return row.leafIndex >= scope.fromLeafIndex && row.leafIndex <= scope.toLeafIndex;
    case "dateRange":
      return (
        typeof row.createdAtMs === "number" &&
        row.createdAtMs >= scope.fromMs &&
        row.createdAtMs <= scope.toMs
      );
    default:
      return false;
  }
}

/** Human description of a scope, for UI and for the grant's own `statement`. */
export function describeScope(scope: DisclosureScope): string {
  switch (scope.type) {
    case "account":
      return "the entire shielded account, including notes created in the future";
    case "notes":
      return `${scope.commitments.length} specific shielded note${scope.commitments.length === 1 ? "" : "s"}`;
    case "transaction":
      return `every shielded note created by ${scope.txDigests.length} specific transaction${scope.txDigests.length === 1 ? "" : "s"}`;
    case "leafRange":
      return `shielded notes at leaf indices ${scope.fromLeafIndex}–${scope.toLeafIndex}`;
    case "dateRange":
      return `shielded notes created between ${new Date(scope.fromMs).toISOString()} and ${new Date(scope.toMs).toISOString()}`;
    default:
      return "an unrecognised scope (treat as empty)";
  }
}

/** The artefact handed to a counterparty, auditor, or regulator. */
export type DisclosureReceipt = {
  kind: typeof DISCLOSURE_RECEIPT_KIND;
  version: typeof DISCLOSURE_VERSION;
  /** Random id so two receipts over the same notes are distinguishable. */
  receiptId: string;
  issuedAtMs: number;
  /**
   * Who says they are disclosing. UNAUTHENTICATED by design: the receipt
   * proves a note exists with an amount, NOT who issued the claim. Pair it
   * with an out-of-band signature (see DISCLOSURE.md) if you need that.
   */
  disclosedBy: { label: string | null; suiAddress: string | null };
  scope: DisclosureScope;
  openings: NoteOpening[];
  /** Human-readable restatement of the claim, derived from the openings. */
  statement: string;
  /** Fixed honesty notice, carried inside the artefact so it can't be lost. */
  notice: string;
};

/**
 * The notice every receipt carries. Verbatim and load-bearing: a receipt that
 * travels without it invites the reader to over-read the claim.
 */
export const RECEIPT_NOTICE =
  "This receipt opens specific shielded notes. It proves each listed note " +
  "exists on chain with exactly the stated amount. It does NOT prove the note " +
  "is still unspent, does NOT identify the sender, and does NOT prove who " +
  "controls the owner key. Opening a note is irreversible: whoever holds this " +
  "document can link that note's amount to its on-chain commitment forever.";

// ── canonicalisation ───────────────────────────────────────────────────────

/**
 * Deterministic JSON: object keys sorted lexicographically at every depth, no
 * insignificant whitespace, arrays in given order. Two parties that build the
 * same logical document get byte-identical output, so `documentDigest` is a
 * stable identifier for "this exact disclosure".
 *
 * Rejects anything that cannot round-trip losslessly (undefined, functions,
 * NaN/Infinity, bigint) rather than silently dropping it — a disclosure that
 * quietly loses a field is a disclosure that means something else.
 */
export function canonicalJson(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("canonicalJson: non-finite number");
    }
    return JSON.stringify(value);
  }
  if (t === "bigint") {
    throw new Error("canonicalJson: bigint is not serialisable; use a decimal string");
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => encode(v)).join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) {
        throw new Error(`canonicalJson: undefined at key "${k}"`);
      }
      parts.push(`${JSON.stringify(k)}:${encode(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${t}`);
}

/** SHA-256 over the canonical bytes, lowercase hex. The document's identity. */
export async function documentDigest(value: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto subtle unavailable; cannot digest document");
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  const digest = await subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── secret-leak guard ──────────────────────────────────────────────────────

/**
 * Field names that must NEVER appear in a disclosure document. A note's
 * `blinding` IS the thing being disclosed and is deliberately absent from this
 * list; a SPENDING key, a note master, or a raw seed is a different class of
 * secret entirely — handing one over would give away the money, not the story.
 *
 * Matching is case-insensitive and ignores `_`/`-`, so `spending_key`,
 * `spendingKey` and `SPENDING-KEY` are all caught.
 */
const FORBIDDEN_KEY_NAMES = [
  "spendingkey",
  "spendkey",
  "notemaster",
  "master",
  "masterseed",
  "seed",
  "mnemonic",
  "privatekey",
  "privkey",
  "secretkey",
  "signingkey",
  "keypair",
  // The circuit's spend-authorising scalar (`noteNullifier`'s `sig`). Holding
  // it lets you derive a note's nullifier, i.e. spend it. Not disclosure
  // material. ("signature" is deliberately NOT forbidden — an out-of-band
  // ownership attestation is a legitimate thing to staple to a receipt.)
  "sig",
] as const;

function normaliseKey(k: string): string {
  return k.toLowerCase().replace(/[_-]/g, "");
}

/**
 * Walk a document and throw if it carries a forbidden secret field. Called by
 * every serialiser in this subsystem, so an accidental
 * `{ ...keypair, ...grant }` spread cannot silently ship a spending key inside
 * a disclosure. Cheap, total, and fails CLOSED.
 */
export function assertNoSecretLeak(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecretLeak(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY_NAMES.includes(normaliseKey(k) as (typeof FORBIDDEN_KEY_NAMES)[number])) {
      throw new Error(
        `refusing to serialise a disclosure containing "${k}" at ${path}: ` +
          "that is spend-authority material, not disclosure material"
      );
    }
    assertNoSecretLeak(v, `${path}.${k}`);
  }
}

/**
 * Canonicalise a document AFTER the secret-leak guard. This is the ONLY
 * function the rest of the subsystem uses to turn a document into bytes.
 */
export function serializeDocument(value: unknown): string {
  assertNoSecretLeak(value);
  return canonicalJson(value);
}

/** Pretty (indented) form for a human / a file on disk. Same guard applies. */
export function prettyDocument(value: unknown): string {
  assertNoSecretLeak(value);
  return JSON.stringify(value, null, 2);
}

// ── small shared helpers ───────────────────────────────────────────────────

/** Strict decimal-string → bigint. Rejects hex, signs, spaces, empties. */
export function parseDecimal(s: unknown, label: string): bigint {
  if (typeof s !== "string" || !/^(0|[1-9][0-9]*)$/.test(s)) {
    throw new Error(`${label}: expected a non-negative decimal string`);
  }
  return BigInt(s);
}

/** A 16-byte random id as lowercase hex, for `receiptId` / `grantId`. */
export function randomId(): string {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) throw new Error("crypto.getRandomValues unavailable");
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Render a base-unit amount with `decimals` places, for the statement text. */
export function formatBaseUnits(amount: bigint, decimals: number): string {
  if (decimals <= 0) return amount.toString();
  const d = BigInt(10) ** BigInt(decimals);
  const whole = amount / d;
  const frac = (amount % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
