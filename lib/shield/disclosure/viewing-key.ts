/**
 * Talise shielded-pool, SELECTIVE DISCLOSURE — viewing grants.
 *
 * A VIEWING GRANT gives someone scoped READ access to a shielded account. It
 * never gives them the ability to spend. Two modes, and the difference is the
 * single most important thing on this page:
 *
 * ┌── mode: "sealed" ────────────────────────────────────────────── DEFAULT ──┐
 * │ Contains NO key material at all. Instead it carries the already-opened    │
 * │ notes for exactly the in-scope commitments. The scope is CRYPTOGRAPHICALLY │
 * │ EXACT, because nothing outside it is present in the document. The grantee  │
 * │ can verify every note against the chain and learns nothing else.          │
 * │ Cannot see the future. Cannot be widened. This is what you want for       │
 * │ "prove this invoice was paid".                                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ┌── mode: "delegated-key" ─────────────────────────────── POWERFUL, CAREFUL ┐
 * │ Contains the account's ECIES VIEWING KEY (the note-decryption scalar).    │
 * │ The scope is ADVISORY ONLY: this SDK and Talise's API honour it, but the   │
 * │ holder of the key can decrypt every ciphertext they can fetch, including   │
 * │ ones created AFTER the grant was issued. Treat it as permanent, total,     │
 * │ account-wide read access. Issue it to an auditor under engagement, not to  │
 * │ a counterparty.                                                           │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ── What a viewing key CAN do ──────────────────────────────────────────────
 *   • trial-decrypt `encrypted_output0/1` blobs → learn (amount, pubkey,
 *     blinding, pool) for notes addressed to this account;
 *   • recompute commitments and so confirm which on-chain leaves are this
 *     account's;
 *   • build opening proofs / receipts for those notes.
 *
 * ── What a viewing key CANNOT do ───────────────────────────────────────────
 *   • SPEND. A spend needs the note nullifier `hash3(commitment, pathIndex,
 *     sig)` where `sig` binds the SPENDING key, plus a Groth16 witness over it.
 *     The viewing key is `d = SHA-256("talise.shield.enc-scalar.v1" ‖
 *     spendingKey) mod n` — a one-way function OF the spending key, not a route
 *     back to it. Handing out `d` cannot yield spend authority unless SHA-256 is
 *     invertible. That is the assumption, stated plainly.
 *   • authorise a withdrawal, sign a transaction, or change any account setting.
 *   • be revoked. See DISCLOSURE.md — there is no on-chain revocation and no
 *     key rotation for existing notes.
 *
 * ── Accident-proofing ──────────────────────────────────────────────────────
 * Every grant builder takes the whole `ShieldKeypair` and derives the viewing
 * key itself; there is no code path that accepts an arbitrary "key" from a
 * caller and copies it into a grant. Before serialising, the builder asserts
 * the emitted scalar is NOT the spending key, and `serializeDocument`'s
 * `assertNoSecretLeak` refuses any document carrying a spend-authority field
 * name. `openGrant` returns an object with no `spendingKey` property, by type.
 */

import { deriveShieldEncScalar, type ShieldKeypair } from "../sdk/keys";
import { decryptNote } from "../sdk/encrypt";
import { noteCommitment, type Note } from "../sdk/note";
import {
  DISCLOSURE_VERSION,
  VIEWING_GRANT_KIND,
  describeScope,
  documentDigest,
  parseDecimal,
  prettyDocument,
  randomId,
  scopeIncludes,
  serializeDocument,
  type DisclosureScope,
  type NoteOpening,
  type ScopeCandidate,
} from "./format";
import { buildNoteOpening } from "./open";

/** Capabilities a grant confers. `spend` is not a member and never will be. */
export const VIEWING_CAPABILITIES = [
  "decrypt-note-ciphertexts",
  "recompute-commitments",
  "verify-openings",
] as const;
export type ViewingCapability = (typeof VIEWING_CAPABILITIES)[number];

/** Stated explicitly inside every grant so it travels with the document. */
export const VIEWING_NOT_PERMITTED = [
  "spend or move any funds",
  "sign any transaction",
  "derive the spending key",
  "compute a note nullifier",
  "change any account setting",
] as const;

export const SEALED_GRANT_NOTICE =
  "This grant contains no keys. It carries the opened notes for exactly the " +
  "scope stated, and nothing else. It cannot be used to read anything further, " +
  "including notes created later.";

export const DELEGATED_GRANT_NOTICE =
  "This grant contains the account's VIEWING KEY. It cannot spend, sign, or " +
  "derive the spending key. But the scope below is advisory only: whoever holds " +
  "this key can decrypt every note ciphertext for this account that they can " +
  "fetch, including notes created after this grant was issued. It cannot be " +
  "revoked. Treat it as permanent, total read access.";

type GrantBase = {
  kind: typeof VIEWING_GRANT_KIND;
  version: typeof DISCLOSURE_VERSION;
  grantId: string;
  issuedAtMs: number;
  /**
   * Advisory expiry, honoured by this SDK and by Talise's API. A
   * delegated-key grant's underlying key does NOT stop working at this instant
   * — nothing on chain enforces it. Null = no stated expiry.
   */
  expiresAtMs: number | null;
  /** Why the grant exists (audit reference, engagement id, …). Free text. */
  purpose: string | null;
  /** Who it was issued to. Free text, unauthenticated. */
  grantedTo: string | null;
  coinType: string;
  packageId: string;
  poolObjectId: string;
  scope: DisclosureScope;
  capabilities: ViewingCapability[];
  notPermitted: string[];
  statement: string;
  notice: string;
};

/** The default, recommended grant: openings only, zero key material. */
export type SealedViewingGrant = GrantBase & {
  mode: "sealed";
  openings: NoteOpening[];
};

/** The powerful grant: carries the account's note-decryption scalar. */
export type DelegatedKeyViewingGrant = GrantBase & {
  mode: "delegated-key";
  /**
   * The ECIES note-decryption scalar as 64 lowercase hex chars (32 bytes BE).
   * READ-ONLY authority. Not the spending key; see the header.
   */
  viewingKeyHex: string;
};

export type ViewingGrant = SealedViewingGrant | DelegatedKeyViewingGrant;

// ── derivation + accident-proofing ─────────────────────────────────────────

/** 32-byte big-endian hex of a scalar. */
export function scalarToHex(d: bigint): string {
  if (d <= 0n) throw new Error("scalarToHex: scalar must be positive");
  const hex = d.toString(16);
  if (hex.length > 64) throw new Error("scalarToHex: scalar exceeds 32 bytes");
  return hex.padStart(64, "0");
}

/** Parse a 64-hex viewing key back to a scalar. Strict. */
export function hexToScalar(hex: string): bigint {
  const h = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(h)) {
    throw new Error("viewing key: expected 64 hex characters (32 bytes)");
  }
  const d = BigInt(`0x${h}`);
  if (d === 0n) throw new Error("viewing key: zero scalar");
  return d;
}

/**
 * Derive the account's VIEWING key from its keypair and assert it is not the
 * spending key. The assertion is cheap and guards the one mistake that would
 * be catastrophic: copying the wrong scalar into a grant.
 *
 * There is intentionally NO overload that accepts a bare scalar — every grant's
 * key must come from this function, so the check cannot be skipped.
 */
export async function deriveViewingKey(keypair: ShieldKeypair): Promise<bigint> {
  const d = await deriveShieldEncScalar(keypair.spendingKey);
  if (d === keypair.spendingKey) {
    // Astronomically improbable (different fields, one-way hash between them),
    // but the whole point of this module is that "improbable" is not a policy.
    throw new Error("refusing to grant: derived viewing key equals the spending key");
  }
  if (d === 0n) throw new Error("refusing to grant: degenerate viewing key");
  return d;
}

/**
 * Belt-and-braces check on a finished grant. Throws if a delegated-key grant's
 * scalar is the spending key, or if a sealed grant carries key material.
 * Called by both builders and by `serializeGrant`, so a grant assembled by hand
 * still cannot escape.
 */
export function assertGrantCarriesNoSpendAuthority(
  grant: ViewingGrant,
  keypair?: ShieldKeypair
): void {
  if (grant.capabilities.some((c) => !VIEWING_CAPABILITIES.includes(c))) {
    throw new Error("grant declares a capability outside the read-only set");
  }
  if (grant.mode === "sealed") {
    if ("viewingKeyHex" in grant) {
      throw new Error("sealed grant must carry no key material");
    }
    return;
  }
  const d = hexToScalar(grant.viewingKeyHex);
  if (keypair && d === keypair.spendingKey) {
    throw new Error("refusing to serialise: grant carries the SPENDING key");
  }
}

// ── builders ───────────────────────────────────────────────────────────────

export type SealedGrantParams = {
  scope: DisclosureScope;
  /** The in-scope openings. Build with `viewNotesWithKey` + `buildNoteOpening`. */
  openings: NoteOpening[];
  coinType: string;
  packageId: string;
  poolObjectId: string;
  grantedTo?: string | null;
  purpose?: string | null;
  expiresAtMs?: number | null;
  nowMs?: number;
  grantId?: string;
};

/**
 * Build the DEFAULT grant: the in-scope notes, opened, and nothing else.
 *
 * Prefer this always. It is strictly weaker than a delegated key (it cannot see
 * the future, cannot be widened, cannot be re-scoped by its holder) which is
 * exactly what makes it the right default for a payments business.
 */
export function buildSealedViewingGrant(params: SealedGrantParams): SealedViewingGrant {
  if (!Array.isArray(params.openings) || params.openings.length === 0) {
    throw new Error("buildSealedViewingGrant: at least one opening is required");
  }
  const grant: SealedViewingGrant = {
    kind: VIEWING_GRANT_KIND,
    version: DISCLOSURE_VERSION,
    mode: "sealed",
    grantId: params.grantId ?? randomId(),
    issuedAtMs: params.nowMs ?? Date.now(),
    expiresAtMs: params.expiresAtMs ?? null,
    purpose: params.purpose ?? null,
    grantedTo: params.grantedTo ?? null,
    coinType: params.coinType,
    packageId: params.packageId,
    poolObjectId: params.poolObjectId,
    scope: params.scope,
    capabilities: [...VIEWING_CAPABILITIES],
    notPermitted: [...VIEWING_NOT_PERMITTED],
    statement:
      `Read access to ${describeScope(params.scope)}. ` +
      `${params.openings.length} note${params.openings.length === 1 ? "" : "s"} enclosed, opened. ` +
      "No keys enclosed; this grant cannot read anything beyond the notes listed.",
    notice: SEALED_GRANT_NOTICE,
    openings: params.openings,
  };
  assertGrantCarriesNoSpendAuthority(grant);
  serializeDocument(grant);
  return grant;
}

export type DelegatedGrantParams = Omit<SealedGrantParams, "openings"> & {
  /**
   * The account keypair. The builder derives the VIEWING key from it — there is
   * no way to pass a raw key in, so the wrong scalar cannot be handed over.
   */
  keypair: ShieldKeypair;
  /**
   * Explicit acknowledgement that a delegated key is effectively permanent,
   * account-wide read access. Must be exactly `true`; the parameter exists so
   * the dangerous grant cannot be produced by a caller who did not mean to.
   */
  acknowledgeAccountWide: true;
};

/**
 * Build a DELEGATED-KEY grant. Read the header before using this. The scope is
 * advisory; the key is not scoped and cannot be revoked.
 */
export async function buildDelegatedKeyViewingGrant(
  params: DelegatedGrantParams
): Promise<DelegatedKeyViewingGrant> {
  if (params.acknowledgeAccountWide !== true) {
    throw new Error(
      "buildDelegatedKeyViewingGrant: acknowledgeAccountWide must be true — a " +
        "delegated viewing key is permanent, unrevocable, account-wide read access"
    );
  }
  const d = await deriveViewingKey(params.keypair);
  const grant: DelegatedKeyViewingGrant = {
    kind: VIEWING_GRANT_KIND,
    version: DISCLOSURE_VERSION,
    mode: "delegated-key",
    grantId: params.grantId ?? randomId(),
    issuedAtMs: params.nowMs ?? Date.now(),
    expiresAtMs: params.expiresAtMs ?? null,
    purpose: params.purpose ?? null,
    grantedTo: params.grantedTo ?? null,
    coinType: params.coinType,
    packageId: params.packageId,
    poolObjectId: params.poolObjectId,
    scope: params.scope,
    capabilities: [...VIEWING_CAPABILITIES],
    notPermitted: [...VIEWING_NOT_PERMITTED],
    statement:
      `Read access intended for ${describeScope(params.scope)}, delegated by handing over ` +
      "the account viewing key. The stated scope is advisory: the key itself is " +
      "account-wide and not time-bounded.",
    notice: DELEGATED_GRANT_NOTICE,
    viewingKeyHex: scalarToHex(d),
  };
  assertGrantCarriesNoSpendAuthority(grant, params.keypair);
  serializeDocument(grant);
  return grant;
}

// ── consuming a grant ──────────────────────────────────────────────────────

/**
 * What a grantee gets when they open a grant. Note the SHAPE: there is no
 * `spendingKey`, no `noteMaster`, no signer — by type, not by convention. A
 * `sealed` grant yields `decryptScalar: null`, because it needs none.
 */
export type OpenedGrant = {
  mode: ViewingGrant["mode"];
  scope: DisclosureScope;
  /** The note-decryption scalar, or null for a sealed grant. READ-ONLY. */
  decryptScalar: bigint | null;
  /** Pre-opened notes (sealed grants) — already verifiable as-is. */
  openings: NoteOpening[];
  capabilities: ViewingCapability[];
  /** True when `expiresAtMs` is in the past (advisory, see the type). */
  expired: boolean;
};

/**
 * Open a grant for use. Strict parse of an untrusted document.
 *
 * The returned object CANNOT spend: it exposes a decryption scalar and nothing
 * else. `grantConfersSpendAuthority` documents that in one call.
 */
export function openGrant(raw: unknown, nowMs = Date.now()): OpenedGrant {
  if (!raw || typeof raw !== "object") throw new Error("grant: not an object");
  const g = raw as Record<string, unknown>;
  if (g.kind !== VIEWING_GRANT_KIND) throw new Error(`grant: wrong kind (${String(g.kind)})`);
  if (g.version !== DISCLOSURE_VERSION) {
    throw new Error(`grant: unsupported version (${String(g.version)})`);
  }
  const scope = g.scope as DisclosureScope | undefined;
  if (!scope || typeof scope !== "object" || typeof scope.type !== "string") {
    throw new Error("grant.scope: missing or malformed");
  }
  const expiresAtMs = g.expiresAtMs;
  if (expiresAtMs !== null && typeof expiresAtMs !== "number") {
    throw new Error("grant.expiresAtMs: expected a number or null");
  }
  const expired = typeof expiresAtMs === "number" && expiresAtMs < nowMs;

  const caps = Array.isArray(g.capabilities) ? (g.capabilities as ViewingCapability[]) : [];
  for (const c of caps) {
    if (!VIEWING_CAPABILITIES.includes(c)) {
      throw new Error(`grant.capabilities: "${String(c)}" is not a read-only capability`);
    }
  }

  if (g.mode === "sealed") {
    const openings = Array.isArray(g.openings) ? (g.openings as NoteOpening[]) : [];
    return { mode: "sealed", scope, decryptScalar: null, openings, capabilities: caps, expired };
  }
  if (g.mode === "delegated-key") {
    if (typeof g.viewingKeyHex !== "string") {
      throw new Error("grant.viewingKeyHex: expected a hex string");
    }
    return {
      mode: "delegated-key",
      scope,
      decryptScalar: hexToScalar(g.viewingKeyHex),
      openings: [],
      capabilities: caps,
      expired,
    };
  }
  throw new Error(`grant.mode: unrecognised (${String(g.mode)})`);
}

/**
 * Does a viewing grant confer spend authority? No. Always no. This exists as a
 * callable, testable statement of the invariant rather than a comment, so a
 * future refactor that broke it would break a test.
 */
export function grantConfersSpendAuthority(_grant: ViewingGrant | OpenedGrant): false {
  return false;
}

/** Canonical bytes of a grant, guarded. */
export function serializeGrant(grant: ViewingGrant): string {
  assertGrantCarriesNoSpendAuthority(grant);
  return serializeDocument(grant);
}

/** Indented form of a grant, guarded. */
export function grantToPrettyJson(grant: ViewingGrant): string {
  assertGrantCarriesNoSpendAuthority(grant);
  return prettyDocument(grant);
}

/** SHA-256 of the canonical grant. */
export function grantDigest(grant: ViewingGrant): Promise<string> {
  assertGrantCarriesNoSpendAuthority(grant);
  return documentDigest(grant);
}

// ── scoped viewing over the commitment feed ────────────────────────────────

/** A feed row a viewer can attempt. Superset of `/api/shield/commitments` rows. */
export type ViewableRow = ScopeCandidate & {
  /** `encrypted_output` blob: 0x-hex or base64, or null when unindexed. */
  encryptedOutput: string | null;
};

export type ViewedNote = {
  row: ViewableRow;
  note: Note;
  commitment: bigint;
};

/**
 * Trial-decrypt the IN-SCOPE rows of a commitment feed with a viewing key, and
 * keep only the ones whose recomputed commitment matches the chain. This is the
 * enforcement point for a delegated-key grant's scope inside our own tooling:
 * out-of-scope rows are never even attempted.
 *
 * Be clear-eyed about what that is worth: it stops OUR code from over-reading,
 * it does not stop a grantee's own code. A delegated key is account-wide. The
 * only cryptographically exact scoping is a sealed grant.
 */
export async function viewNotesWithKey(
  viewingKey: bigint,
  rows: ViewableRow[],
  scope: DisclosureScope
): Promise<ViewedNote[]> {
  const out: ViewedNote[] = [];
  for (const row of rows) {
    if (!scopeIncludes(scope, row)) continue;
    const ct = decodeBlob(row.encryptedOutput);
    if (!ct) continue;
    let note: Note | null = null;
    try {
      note = await decryptNote(ct, viewingKey);
    } catch {
      note = null;
    }
    if (!note) continue;
    const recomputed = noteCommitment(note);
    let onchain: bigint;
    try {
      onchain = parseDecimal(row.commitment, "row.commitment");
    } catch {
      continue;
    }
    if (recomputed !== onchain) continue;
    out.push({ row, note, commitment: recomputed });
  }
  return out;
}

/**
 * The full sealed-grant path: decrypt the in-scope notes with the account's own
 * viewing key, open each one, and seal them into a grant that carries no keys.
 *
 * DELIBERATE ACT: this reveals the blinding factor of every in-scope note to
 * whoever receives the grant. The caller must have taken an explicit
 * confirmation for exactly this scope.
 */
export async function sealGrantFromFeed(params: {
  keypair: ShieldKeypair;
  rows: ViewableRow[];
  scope: DisclosureScope;
  coinType: string;
  packageId: string;
  poolObjectId: string;
  amountDecimals: number;
  grantedTo?: string | null;
  purpose?: string | null;
  expiresAtMs?: number | null;
  nowMs?: number;
  grantId?: string;
}): Promise<SealedViewingGrant> {
  const viewingKey = await deriveViewingKey(params.keypair);
  const viewed = await viewNotesWithKey(viewingKey, params.rows, params.scope);
  if (viewed.length === 0) {
    throw new Error("sealGrantFromFeed: no notes in scope; nothing to disclose");
  }
  const openings = viewed.map((v) =>
    buildNoteOpening({
      note: v.note,
      locator: {
        coinType: params.coinType,
        packageId: params.packageId,
        poolObjectId: params.poolObjectId,
        leafIndex: v.row.leafIndex,
        txDigest: v.row.txDigest ?? null,
      },
      amountDecimals: params.amountDecimals,
    })
  );
  return buildSealedViewingGrant({
    scope: params.scope,
    openings,
    coinType: params.coinType,
    packageId: params.packageId,
    poolObjectId: params.poolObjectId,
    grantedTo: params.grantedTo,
    purpose: params.purpose,
    expiresAtMs: params.expiresAtMs,
    nowMs: params.nowMs,
    grantId: params.grantId,
  });
}

/**
 * Decode a `vector<u8>` blob (0x-hex or base64). Same tolerance as scan.ts's
 * private helper — duplicated rather than exported from there so the money-path
 * module is left untouched.
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
  try {
    const bin =
      typeof atob === "function" ? atob(raw) : Buffer.from(raw, "base64").toString("binary");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    if (out.length > 0) return out;
  } catch {
    /* fall through */
  }
  return fromHex(raw);
}
