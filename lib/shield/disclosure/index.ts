/**
 * Talise shielded-pool, SELECTIVE DISCLOSURE — public surface.
 *
 * Read `web/lib/shield/DISCLOSURE.md` before using any of this. It states
 * exactly what a disclosure proves, what it irreversibly leaks, and how it
 * interacts with the pool's known open gaps.
 *
 * Three documents:
 *   talise.shield.note-opening/1        one note, opened (the atom).
 *   talise.shield.disclosure-receipt/1  a bundle of openings for an auditor.
 *   talise.shield.viewing-grant/1       scoped read access (sealed | delegated).
 *
 * Nothing here needs the Groth16 trusted setup, a verifying key, or an on-chain
 * verifier. The only cryptographic assumption is Poseidon-BN254 collision
 * resistance, which the pool already rests on.
 *
 * Server + client importable. No `server-only`, no Node-only deps — the
 * verifier must run in a stranger's browser or under plain `node`.
 */

export {
  NOTE_OPENING_KIND,
  DISCLOSURE_RECEIPT_KIND,
  VIEWING_GRANT_KIND,
  DISCLOSURE_VERSION,
  RECEIPT_NOTICE,
  canonicalJson,
  documentDigest,
  serializeDocument,
  prettyDocument,
  assertNoSecretLeak,
  parseDecimal,
  randomId,
  formatBaseUnits,
  scopeIncludes,
  describeScope,
} from "./format";
export type {
  NoteLocator,
  OpenedNoteFields,
  NoteOpening,
  DisclosureScope,
  DisclosureReceipt,
  ScopeCandidate,
} from "./format";

export {
  buildNoteOpening,
  parseNoteOpening,
  verifyOpeningLocally,
  openingStatement,
  poolFieldFromAddress,
} from "./open";
export type { BuildOpeningParams, LocalOpeningCheck } from "./open";

export {
  buildDisclosureReceipt,
  buildReceiptFromNotes,
  receiptStatement,
  receiptToCanonicalJson,
  receiptToPrettyJson,
  receiptDigest,
  receiptFilename,
} from "./receipt";
export type { BuildReceiptParams } from "./receipt";

export {
  verifyDisclosureReceipt,
  jsonRpcChainLookup,
  normalizeAddress,
  sameTypeTag,
  DEFAULT_FULLNODE_URL,
  DOES_NOT_PROVE,
  UNCHECKED_OWNER_CAVEAT,
} from "./verify";
export type {
  VerifyOptions,
  ReceiptVerification,
  OpeningVerification,
  ChainLookup,
  ChainTxView,
  ChainCommitmentEvent,
  ChainCheckStatus,
} from "./verify";

export {
  VIEWING_CAPABILITIES,
  VIEWING_NOT_PERMITTED,
  SEALED_GRANT_NOTICE,
  DELEGATED_GRANT_NOTICE,
  deriveViewingKey,
  assertGrantCarriesNoSpendAuthority,
  buildSealedViewingGrant,
  buildDelegatedKeyViewingGrant,
  openGrant,
  grantConfersSpendAuthority,
  serializeGrant,
  grantToPrettyJson,
  grantDigest,
  scalarToHex,
  hexToScalar,
  viewNotesWithKey,
  sealGrantFromFeed,
} from "./viewing-key";
export type {
  ViewingGrant,
  SealedViewingGrant,
  DelegatedKeyViewingGrant,
  OpenedGrant,
  ViewingCapability,
  ViewableRow,
  ViewedNote,
  SealedGrantParams,
  DelegatedGrantParams,
} from "./viewing-key";
