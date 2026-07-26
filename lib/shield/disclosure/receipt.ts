/**
 * Talise shielded-pool, SELECTIVE DISCLOSURE — receipt assembly.
 *
 * Bundles one or more note openings into the artefact a business hands to a
 * counterparty, an auditor, or a regulator. A receipt is:
 *
 *   • plain JSON, self-describing, versioned;
 *   • verifiable by a stranger with `verifyDisclosureReceipt` + any fullnode;
 *   • unsigned by Talise — deliberately. Adding a Talise signature would invite
 *     a reader to trust Talise instead of the chain, which is exactly backwards.
 *     The binding is the on-chain commitment.
 *
 * Building a receipt is always an explicit user action. Nothing in this module
 * is called on a timer, on page load, or as a side effect of a send.
 */

import {
  DISCLOSURE_RECEIPT_KIND,
  DISCLOSURE_VERSION,
  RECEIPT_NOTICE,
  documentDigest,
  formatBaseUnits,
  prettyDocument,
  randomId,
  serializeDocument,
  type DisclosureReceipt,
  type DisclosureScope,
  type NoteOpening,
} from "./format";
import { buildNoteOpening, type BuildOpeningParams } from "./open";

export type BuildReceiptParams = {
  /** Openings to bundle. Build them with {@link buildNoteOpening}. */
  openings: NoteOpening[];
  /** What the discloser says this covers. Advisory, see `DisclosureScope`. */
  scope?: DisclosureScope;
  /** Free-text label + optional Sui address for the discloser. Unauthenticated. */
  disclosedBy?: { label?: string | null; suiAddress?: string | null };
  /** Override the clock (tests / deterministic fixtures). */
  nowMs?: number;
  /** Override the random id (tests / deterministic fixtures). */
  receiptId?: string;
};

/**
 * Assemble a receipt. Refuses an empty bundle: an "empty disclosure" reads as a
 * proof of absence, which this format cannot make.
 */
export function buildDisclosureReceipt(params: BuildReceiptParams): DisclosureReceipt {
  const { openings } = params;
  if (!Array.isArray(openings) || openings.length === 0) {
    throw new Error("buildDisclosureReceipt: at least one opening is required");
  }

  const scope: DisclosureScope =
    params.scope ?? { type: "notes", commitments: openings.map((o) => o.commitment) };

  const receipt: DisclosureReceipt = {
    kind: DISCLOSURE_RECEIPT_KIND,
    version: DISCLOSURE_VERSION,
    receiptId: params.receiptId ?? randomId(),
    issuedAtMs: params.nowMs ?? Date.now(),
    disclosedBy: {
      label: params.disclosedBy?.label ?? null,
      suiAddress: params.disclosedBy?.suiAddress ?? null,
    },
    scope,
    openings,
    statement: receiptStatement(openings),
    notice: RECEIPT_NOTICE,
  };

  // Guard before the document can escape this function.
  serializeDocument(receipt);
  return receipt;
}

/**
 * One-shot convenience: notes → openings → receipt. Every note is opened, so
 * the caller must have collected an explicit confirmation per note first.
 */
export function buildReceiptFromNotes(
  notes: BuildOpeningParams[],
  rest: Omit<BuildReceiptParams, "openings"> = {}
): DisclosureReceipt {
  return buildDisclosureReceipt({
    ...rest,
    openings: notes.map((n) => buildNoteOpening(n)),
  });
}

/**
 * Deterministic summary sentence, derived only from the openings so it can
 * never assert more than the fields do. Totals are grouped per coin type —
 * summing across assets would be a lie.
 */
export function receiptStatement(openings: NoteOpening[]): string {
  const byCoin = new Map<string, { total: bigint; decimals: number; count: number }>();
  for (const o of openings) {
    const key = o.locator.coinType;
    const cur = byCoin.get(key) ?? { total: 0n, decimals: o.amountDecimals, count: 0 };
    cur.total += BigInt(o.note.amount);
    cur.count += 1;
    byCoin.set(key, cur);
  }
  const parts = [...byCoin.entries()].map(([coinType, v]) => {
    const asset = coinType.split("::").pop() ?? coinType;
    return `${formatBaseUnits(v.total, v.decimals)} ${asset} across ${v.count} shielded note${v.count === 1 ? "" : "s"}`;
  });
  return `This receipt opens ${parts.join(" and ")}. Each note's amount is bound to a commitment already published on Sui; verify it against a fullnode of your choosing.`;
}

/** Canonical bytes (sorted keys, no whitespace) — the digested form. */
export function receiptToCanonicalJson(receipt: DisclosureReceipt): string {
  return serializeDocument(receipt);
}

/** Indented form, for a file the recipient will actually open and read. */
export function receiptToPrettyJson(receipt: DisclosureReceipt): string {
  return prettyDocument(receipt);
}

/** SHA-256 of the canonical receipt. Quote this when referring to a receipt. */
export function receiptDigest(receipt: DisclosureReceipt): Promise<string> {
  return documentDigest(receipt);
}

/** Suggested filename for a downloaded receipt. */
export function receiptFilename(receipt: DisclosureReceipt): string {
  const stamp = new Date(receipt.issuedAtMs).toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `talise-disclosure-${stamp}-${receipt.receiptId.slice(0, 8)}.json`;
}
