/**
 * Talise shielded-pool, SELECTIVE DISCLOSURE — the INDEPENDENT verifier.
 *
 * This module is the whole point of the feature: a counterparty, auditor, or
 * regulator can run it against a disclosure receipt and a Sui fullnode of THEIR
 * choosing and reach a verdict without trusting Talise for anything.
 *
 * Two halves, both required:
 *
 *   1. OFFLINE (open.ts)  — is the revealed tuple a genuine Poseidon preimage
 *                           of the claimed commitment, and is it bound to the
 *                           named pool? Catches an altered amount instantly.
 *   2. ON CHAIN (here)    — is that exact commitment actually on chain, at that
 *                           leaf index, emitted by that package, in that
 *                           transaction? Catches a wholly invented note.
 *
 * Half (1) alone is worthless: anyone can invent (amount, pubkey, blinding) and
 * publish its hash as a "commitment". Half (2) alone is worthless: a commitment
 * on chain says nothing about the amount inside it. Together they are a
 * payment receipt.
 *
 * ── Trust surface ──────────────────────────────────────────────────────────
 *   • Talise: NOT trusted. Nothing in here calls a Talise endpoint. The default
 *     fullnode is Mysten's public mainnet node and the caller can override it
 *     with any node, their own included.
 *   • The fullnode: trusted only for "these events exist in this transaction".
 *     A verifier who does not want to trust one node can pass a different
 *     `fullnodeUrl` (or a custom `chainLookup`) and re-run; agreement across
 *     independent nodes is the practical answer to a lying node.
 *   • Cryptography: Poseidon-BN254 collision resistance. No trusted setup, no
 *     Groth16 verifying key, no ceremony output is involved anywhere.
 *
 * NO server-only imports — this file runs in a browser tab, in a Next route, or
 * under plain `node`.
 */

import {
  DISCLOSURE_RECEIPT_KIND,
  DISCLOSURE_VERSION,
  documentDigest,
  type DisclosureReceipt,
  type DisclosureScope,
} from "./format";
import {
  openingStatement,
  verifyOpeningLocally,
  type LocalOpeningCheck,
} from "./open";

/** Public mainnet fullnode. Overridable — see `VerifyOptions.fullnodeUrl`. */
export const DEFAULT_FULLNODE_URL = "https://fullnode.mainnet.sui.io";

/** One `NewCommitment` event as the verifier needs it. */
export type ChainCommitmentEvent = {
  /** Fully-qualified event type, e.g. `0xpkg::events::NewCommitment<0x..::usdsui::USDSUI>`. */
  type: string;
  /** `NewCommitment.index`, the Merkle leaf index. */
  leafIndex: number | null;
  /** `NewCommitment.commitment` as a decimal string. */
  commitment: string | null;
};

/** What the verifier learned about one transaction from the chain. */
export type ChainTxView = {
  events: ChainCommitmentEvent[];
  /**
   * Object ids the transaction touched (inputs + mutated effects), used to
   * corroborate that the claimed pool object was actually involved. `null` when
   * the node did not return enough detail — then the pool binding rests on the
   * note's own `pool` field only, and the verifier says so.
   */
  touchedObjectIds: string[] | null;
};

/**
 * Pluggable chain reader. Swap it for a GraphQL/gRPC/indexer/explorer-backed
 * implementation, or a fixture in tests. The verifier never assumes JSON-RPC.
 */
export type ChainLookup = (txDigest: string) => Promise<ChainTxView>;

export type VerifyOptions = {
  /** Fullnode JSON-RPC URL. Default {@link DEFAULT_FULLNODE_URL}. */
  fullnodeUrl?: string;
  /** Custom fetch (tests / RN). Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Fully custom chain reader; takes precedence over `fullnodeUrl`. */
  chainLookup?: ChainLookup;
  /**
   * Skip the chain half entirely. Every opening then reports
   * `chain.status = "unchecked"` and the receipt CANNOT be `ok`. Only useful
   * for offline linting of a receipt you are about to send.
   */
  offlineOnly?: boolean;
  /** Reject a receipt carrying more than this many openings. Default 200. */
  maxOpenings?: number;
  /**
   * The owner pubkey (decimal string) every disclosed note must be addressed to.
   *
   * THIS IS THE UPGRADE FROM "a note of X exists" TO "a note of X is addressed
   * to me". Without it, an opening proves only that a note of that amount is in
   * the pool — and the PAYER can open it just as well as the payee (they chose
   * the blinding), so a payer could deposit to themselves and "prove a payment".
   *
   * A recipient verifying a receipt should always pass their OWN pubkey here. A
   * third-party auditor can only pass a pubkey they have been told belongs to a
   * given party, which is an out-of-band claim — see DISCLOSURE.md.
   */
  expectedOwnerPubkey?: string;
};

export type ChainCheckStatus =
  /** commitment + leaf index found in that tx, emitted by that package. */
  | "verified"
  /** the tx exists but carries no such commitment at that leaf. */
  | "not_found"
  /** a commitment IS at that leaf in that tx, but a different one. */
  | "mismatch"
  /** no txDigest in the locator, or `offlineOnly`. */
  | "unchecked"
  /** the node call failed (network, rate limit, unknown digest). */
  | "error";

export type OpeningVerification = {
  commitment: string;
  /** Offline Poseidon-preimage + pool-binding result. */
  local: LocalOpeningCheck;
  chain: {
    status: ChainCheckStatus;
    detail: string;
    /** Did the claimed pool object appear in the transaction? */
    poolBinding: "corroborated" | "absent" | "unavailable";
  };
  /**
   * Is the note addressed to the pubkey the verifier expected?
   * "unchecked" when no `expectedOwnerPubkey` was supplied — in which case the
   * receipt proves a note EXISTS, not that it was paid to anyone in particular.
   */
  owner: { status: "matched" | "mismatch" | "unchecked"; detail: string };
  /** Human restatement, derived from the document. */
  statement: string | null;
  /** True iff local passed, chain is "verified", and the owner check did not fail. */
  ok: boolean;
};

export type ReceiptVerification = {
  ok: boolean;
  /** SHA-256 of the canonical receipt — quote this in correspondence. */
  receiptDigest: string | null;
  receiptId: string | null;
  issuedAtMs: number | null;
  scope: DisclosureScope | null;
  openings: OpeningVerification[];
  /** Fatal structural problems (a malformed receipt yields exactly these). */
  errors: string[];
  /** Claims the verifier is prepared to stand behind, one per verified note. */
  proves: string[];
  /** Claims a reader might wrongly infer. Always populated. */
  doesNotProve: string[];
  /** The fullnode actually consulted, so the verdict is reproducible. */
  fullnodeUrl: string | null;
};

/** Facts a passing receipt never establishes. Stated on EVERY result. */
export const DOES_NOT_PROVE: readonly string[] = [
  "That the disclosed note is still unspent. A note's nullifier is hash3(commitment, pathIndex, sig) and `sig` binds the SPENDING key, which an opening never contains — so the spent-set cannot be checked from this receipt.",
  "Who sent the payment. The shielded pool binds no sender into a note, and the transaction's on-chain sender is the gas relayer, not the payer.",
  "Who controls the owner key. `note.pubkey` is a field element; tying it to a legal person or business is a separate, out-of-band claim.",
  "That this is the discloser's complete financial history. A receipt reveals exactly the notes listed in it and nothing about any other note.",
  "That the discloser is who the `disclosedBy` field says. That field is unauthenticated free text.",
];

/**
 * Added to `doesNotProve` whenever no `expectedOwnerPubkey` was supplied. The
 * gap is real and easy to miss: a payer knows the blinding of the note they
 * created, so a payer can open a note they created for THEMSELVES and present it
 * as a payment. Only checking the owner pubkey closes that.
 */
export const UNCHECKED_OWNER_CAVEAT =
  "That the note was paid to anyone in particular. No expected owner key was " +
  "supplied, and whoever created a note knows its blinding factor — so a payer " +
  "can open a note they created for themselves. Pass the payee's owner pubkey " +
  "(`expectedOwnerPubkey`) to turn this into a proof of payment TO that key.";

// ── JSON-RPC chain reader (the default) ────────────────────────────────────

type RpcEvent = {
  type?: string;
  parsedJson?: unknown;
};

async function rpc<T>(
  url: string,
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch
): Promise<T> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? "rpc error"}`);
  if (body.result === undefined || body.result === null) {
    throw new Error(`${method}: empty result`);
  }
  return body.result;
}

/**
 * The default reader: two public JSON-RPC calls against whichever fullnode the
 * verifier names.
 *
 *   sui_getEvents          → the tx's `NewCommitment` events (the anchor).
 *   sui_getTransactionBlock → the tx's input/mutated object ids (pool binding).
 *
 * The second is best-effort: if a node declines it, the pool binding degrades
 * to "unavailable" and the verifier reports that rather than pretending.
 */
export function jsonRpcChainLookup(
  fullnodeUrl: string,
  fetchImpl: typeof fetch
): ChainLookup {
  return async (txDigest: string): Promise<ChainTxView> => {
    const raw = await rpc<RpcEvent[]>(fullnodeUrl, "sui_getEvents", [txDigest], fetchImpl);
    const events: ChainCommitmentEvent[] = (Array.isArray(raw) ? raw : []).map((ev) => {
      const pj = (ev.parsedJson ?? {}) as { index?: unknown; commitment?: unknown };
      const idxNum = Number(pj.index);
      return {
        type: String(ev.type ?? ""),
        leafIndex: Number.isSafeInteger(idxNum) ? idxNum : null,
        commitment:
          pj.commitment === undefined || pj.commitment === null
            ? null
            : String(pj.commitment),
      };
    });

    let touchedObjectIds: string[] | null = null;
    try {
      const tx = await rpc<unknown>(
        fullnodeUrl,
        "sui_getTransactionBlock",
        [txDigest, { showInput: true, showEffects: true }],
        fetchImpl
      );
      touchedObjectIds = collectObjectIds(tx);
    } catch {
      touchedObjectIds = null; // reported as "unavailable", never as a pass
    }

    return { events, touchedObjectIds };
  };
}

/**
 * Pull every `objectId`-shaped string out of a transaction-block response. A
 * structural walk rather than a pinned path on purpose: Sui's JSON-RPC response
 * shape for inputs/effects has moved between versions, and the check we want
 * ("did this object id take part in this transaction?") is shape-agnostic.
 * Over-collecting is safe here — it can only ever make the pool-binding check
 * MORE likely to corroborate, and corroboration is not what carries the proof
 * (the note's own `pool` field, checked offline, is).
 */
function collectObjectIds(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const v of value) collectObjectIds(v, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (
      (k === "objectId" || k === "id" || k === "objectID") &&
      typeof v === "string" &&
      /^0x[0-9a-fA-F]{1,64}$/.test(v)
    ) {
      out.push(normalizeAddress(v));
    }
    collectObjectIds(v, out, depth + 1);
  }
  return out;
}

/** 0x + 64 lowercase hex, zero-padded. Sui renders ids both padded and not. */
export function normalizeAddress(addr: string): string {
  const hex = addr.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{1,64}$/.test(hex)) return addr.trim().toLowerCase();
  return `0x${hex.padStart(64, "0")}`;
}

/**
 * Compare two Move type tags for equality, tolerating unpadded addresses
 * (`0x2::sui::SUI` vs `0x0000…02::sui::SUI`) and case.
 */
export function sameTypeTag(a: string, b: string): boolean {
  const norm = (t: string) =>
    t
      .trim()
      .toLowerCase()
      .replace(/0x[0-9a-f]{1,64}/g, (m) => normalizeAddress(m));
  return norm(a) === norm(b);
}

// ── the verifier ───────────────────────────────────────────────────────────

/**
 * Verify a disclosure receipt end to end.
 *
 * `ok` is true only when EVERY opening passes both halves. A receipt with one
 * bad opening fails as a whole — a partially-true receipt is a misleading
 * document, and callers reliably read a green tick as "all of it".
 */
export async function verifyDisclosureReceipt(
  raw: unknown,
  opts: VerifyOptions = {}
): Promise<ReceiptVerification> {
  const empty = (errors: string[]): ReceiptVerification => ({
    ok: false,
    receiptDigest: null,
    receiptId: null,
    issuedAtMs: null,
    scope: null,
    openings: [],
    errors,
    proves: [],
    doesNotProve: [...DOES_NOT_PROVE],
    fullnodeUrl: null,
  });

  if (!raw || typeof raw !== "object") return empty(["receipt: not an object"]);
  const r = raw as Record<string, unknown>;
  if (r.kind !== DISCLOSURE_RECEIPT_KIND) {
    return empty([`receipt: wrong kind (${String(r.kind)})`]);
  }
  if (r.version !== DISCLOSURE_VERSION) {
    return empty([`receipt: unsupported version (${String(r.version)})`]);
  }
  const openingsRaw = r.openings;
  if (!Array.isArray(openingsRaw) || openingsRaw.length === 0) {
    return empty(["receipt.openings: expected a non-empty array"]);
  }
  const maxOpenings = opts.maxOpenings ?? 200;
  if (openingsRaw.length > maxOpenings) {
    return empty([`receipt.openings: too many (${openingsRaw.length} > ${maxOpenings})`]);
  }

  const errors: string[] = [];
  const receipt = raw as DisclosureReceipt;

  // The digest identifies the exact bytes verified. Computed over the receipt
  // AS RECEIVED, so quoting it pins what was checked.
  let receiptDigest: string | null = null;
  try {
    receiptDigest = await documentDigest(raw);
  } catch (e) {
    errors.push(`receipt: not canonicalisable (${(e as Error).message})`);
  }

  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const fullnodeUrl = opts.fullnodeUrl ?? DEFAULT_FULLNODE_URL;
  const lookup: ChainLookup | null = opts.offlineOnly
    ? null
    : (opts.chainLookup ?? jsonRpcChainLookup(fullnodeUrl, fetchImpl));

  // One chain read per distinct digest, even if several notes share a tx (both
  // outputs of one `transact` normally do).
  const txCache = new Map<string, Promise<ChainTxView>>();
  const readTx = (digest: string): Promise<ChainTxView> => {
    let p = txCache.get(digest);
    if (!p) {
      p = lookup!(digest);
      txCache.set(digest, p);
    }
    return p;
  };

  const results: OpeningVerification[] = [];
  for (const openingRaw of openingsRaw) {
    const local = verifyOpeningLocally(openingRaw);
    const commitment =
      local.parsed?.commitment?.toString() ??
      (typeof (openingRaw as Record<string, unknown>)?.commitment === "string"
        ? String((openingRaw as Record<string, unknown>).commitment)
        : "?");

    const statement: string | null = local.parsed
      ? openingStatement({
          note: { amount: local.parsed.note.amount.toString() },
          locator: local.parsed.locator,
          amountDecimals: local.parsed.amountDecimals,
        })
      : null;

    // Chain half.
    let status: ChainCheckStatus = "unchecked";
    let detail = "chain check skipped";
    let poolBinding: OpeningVerification["chain"]["poolBinding"] = "unavailable";

    const locator = local.parsed?.locator ?? null;
    if (!lookup) {
      detail = "offlineOnly: chain anchor not checked";
    } else if (!locator) {
      detail = "opening did not parse; nothing to look up";
    } else if (!locator.txDigest) {
      detail = "locator.txDigest is null; the commitment cannot be anchored";
    } else {
      try {
        const view = await readTx(locator.txDigest);
        const wantType = `${locator.packageId}::events::NewCommitment`;
        const candidates = view.events.filter((ev) =>
          sameTypeTag(ev.type.split("<")[0], wantType)
        );
        const typed = candidates.filter((ev) => {
          const generic = ev.type.match(/<(.+)>$/)?.[1];
          // A pool whose events are non-generic (or a node that drops the
          // generic) still anchors the commitment; only REJECT on a positive
          // mismatch of the coin type.
          return !generic || sameTypeTag(generic, locator.coinType);
        });
        const atLeaf = typed.filter((ev) => ev.leafIndex === locator.leafIndex);

        if (candidates.length === 0) {
          status = "not_found";
          detail =
            `transaction ${locator.txDigest} emitted no ${wantType} event ` +
            "(wrong package, wrong transaction, or not a shielded transact)";
        } else if (atLeaf.length === 0) {
          status = "not_found";
          detail = `no commitment at leaf index ${locator.leafIndex} in ${locator.txDigest}`;
        } else if (atLeaf.some((ev) => ev.commitment === commitment)) {
          status = "verified";
          detail = `commitment found at leaf ${locator.leafIndex} in ${locator.txDigest}`;
        } else {
          status = "mismatch";
          detail =
            `leaf ${locator.leafIndex} of ${locator.txDigest} holds commitment ` +
            `${atLeaf.map((e) => e.commitment ?? "?").join(", ")}, not ${commitment}`;
        }

        if (view.touchedObjectIds === null) {
          poolBinding = "unavailable";
        } else {
          poolBinding = view.touchedObjectIds.includes(
            normalizeAddress(locator.poolObjectId)
          )
            ? "corroborated"
            : "absent";
        }
      } catch (e) {
        status = "error";
        detail = `chain read failed: ${(e as Error).message}`;
      }
    }

    // Owner check: is this note addressed to the party the verifier expected?
    let owner: OpeningVerification["owner"] = {
      status: "unchecked",
      detail:
        "no expectedOwnerPubkey supplied — this proves a note exists, not that it " +
        "was paid to any particular party",
    };
    if (opts.expectedOwnerPubkey !== undefined) {
      const want = opts.expectedOwnerPubkey.trim();
      const got = local.parsed?.note.pubkey.toString() ?? null;
      owner =
        got !== null && got === want
          ? { status: "matched", detail: `note is addressed to owner pubkey ${want}` }
          : {
              status: "mismatch",
              detail: `note owner pubkey is ${got ?? "unparseable"}, expected ${want}`,
            };
    }

    results.push({
      commitment,
      local,
      chain: { status, detail, poolBinding },
      owner,
      statement,
      ok: local.ok && status === "verified" && owner.status !== "mismatch",
    });
  }

  const ok = errors.length === 0 && results.length > 0 && results.every((x) => x.ok);
  const proves = ok
    ? results.map((x) =>
        x.owner.status === "matched"
          ? `${x.statement ?? ""} It is addressed to the owner key you supplied.`
          : (x.statement ?? "")
      )
    : [];
  const doesNotProve = [...DOES_NOT_PROVE];
  if (results.some((x) => x.owner.status === "unchecked")) {
    doesNotProve.unshift(UNCHECKED_OWNER_CAVEAT);
  }

  return {
    ok,
    receiptDigest,
    receiptId: typeof receipt.receiptId === "string" ? receipt.receiptId : null,
    issuedAtMs: typeof receipt.issuedAtMs === "number" ? receipt.issuedAtMs : null,
    scope: (receipt.scope as DisclosureScope | undefined) ?? null,
    openings: results,
    errors,
    proves,
    doesNotProve,
    fullnodeUrl: lookup ? fullnodeUrl : null,
  };
}
