/**
 * Canonical `getTransaction` shape used by every verifier route.
 *
 * Phase 1 of the Sui RPC migration replaces JSON-RPC `getTransactionBlock`
 * with gRPC `core.getTransaction`. The two transports return very different
 * proto-vs-REST shapes (see `docs/sui-rpc-migration/patterns.md` pattern #5
 * for the full field-by-field diff). Rather than litter every verifier with
 * transport-specific branches we normalize to ONE shape here.
 *
 * Sub-plans 1.4–1.7 (the four verifier sites) read from `NormalizedTransaction`
 * exclusively. They MUST NOT call `sui().getTransaction()` directly.
 *
 * Consumers and the fields each reads:
 *   • /api/tx/record (1.4) — `status`, `balanceChanges[].ownerAddress`,
 *     `.coinType`, `.amount` (invoice settlement check).
 *   • /api/vault/record (1.5) — `status`, `sender`, `objectChanges[]`
 *     filtered by `kind === "created"` and `objectType` (TaliseVault create).
 *   • /api/vault/migrate-confirm (1.6) — same fields as record + repoint
 *     stage; reads `status` + `sender`.
 *   • /api/vault/repoint-confirm (1.7) — `status`, `sender`.
 *
 * Events are flattened with the OUTER digest injected into each event entry
 * (gRPC events don't carry their own `txDigest`, unlike JSON-RPC where each
 * event had `id.txDigest`). This lets event-aware consumers (none today, but
 * Phase 1.8+ event-scan helpers) treat normalized events as self-describing.
 */

import { sui } from "./sui";

// ─── Public types ────────────────────────────────────────────────────────────

export type OwnerKind = "address" | "object" | "shared" | "immutable" | "unknown";

export type NormalizedExecutionStatus = "success" | "failure";

export type NormalizedObjectChangeKind =
  | "created"
  | "mutated"
  | "deleted"
  // Catch-all for ChangedObject rows the verifiers may want to ignore (e.g.
  // a write to a shared object that we don't classify). Keeps the union
  // exhaustive so verifier `switch` statements don't need a default branch.
  | "other";

export interface NormalizedGasUsed {
  computationCost: bigint;
  storageCost: bigint;
  storageRebate: bigint;
  nonRefundableStorageFee: bigint;
}

export interface NormalizedBalanceChange {
  /** Discriminator for the owner. `address` is the only one the verifiers
   * read today; the others are surfaced for completeness so future callers
   * don't have to drop down into the raw response. */
  ownerKind: OwnerKind;
  /** Lowercased 0x-prefixed address. `null` for shared/immutable/unknown
   * owners. /api/tx/record compares this to the merchant address. */
  ownerAddress: string | null;
  /** Move type tag, e.g. `0x...::usdsui::USDSUI`. */
  coinType: string;
  /** Signed delta in raw minor units. Positive = received, negative = paid. */
  amount: bigint;
}

export interface NormalizedObjectChange {
  /** What happened to this object id during the tx. /api/vault/record filters
   * on `kind === "created"`. */
  kind: NormalizedObjectChangeKind;
  /** Lowercased 0x-prefixed object id. */
  objectId: string;
  /** Move struct tag (e.g. `0x<pkg>::vault::TaliseVault`). May be `null` for
   * deleted objects whose type isn't recoverable from effects alone. */
  objectType: string | null;
  /** Discriminator for the OUTPUT owner (post-transaction). */
  ownerKind: OwnerKind | null;
  /** Lowercased 0x-prefixed owner address. `null` for shared/immutable. */
  ownerAddress: string | null;
}

export interface NormalizedEvent {
  /** Injected from the outer tx digest. gRPC events don't carry it natively
   * (the patterns doc calls this out as a known shape gap). */
  txDigest: string;
  /** Package that emitted the event. */
  packageId: string;
  /** Module name inside the package. */
  module: string;
  /** Address that emitted the event (usually = tx sender). */
  sender: string;
  /** Fully-qualified canonical event type, e.g. `0x<pkg>::mod::EventName`. */
  eventType: string;
  /** BCS-encoded payload. */
  bcs: Uint8Array | null;
  /** Parsed JSON payload. `null` if the SDK couldn't parse it. */
  json: Record<string, unknown> | null;
}

export interface NormalizedTransaction {
  /** Lowercased? No — base58 digest is case-sensitive. Keep as returned. */
  digest: string;
  /** "success" | "failure". /api/tx/record + all three vault verifiers gate
   * on this being "success". */
  status: NormalizedExecutionStatus;
  /** Failure reason text, `null` on success. JSON-RPC's `effects.status.error`
   * was a free-form string; gRPC's is a structured `ExecutionError` — we
   * flatten the message out so callers don't have to introspect it. */
  errorMessage: string | null;
  /** Lowercased 0x-prefixed sender. /api/vault/record + /api/vault/migrate-confirm
   * + /api/vault/repoint-confirm all compare this against the authenticated
   * user's wallet address. */
  sender: string;
  /** Lowercased 0x-prefixed gas payer (may differ from sender for sponsored
   * transactions). */
  gasOwner: string;
  gasBudget: bigint;
  gasPrice: bigint;
  effects: {
    status: NormalizedExecutionStatus;
    errorMessage: string | null;
    gasUsed: NormalizedGasUsed | null;
  };
  /** Object change rows, normalized from gRPC's `effects.changedObjects[]`
   * (which uses `idOperation`) or JSON-RPC's top-level `objectChanges[]`
   * (which uses `type`). /api/vault/record filters `kind === "created"`. */
  objectChanges: NormalizedObjectChange[];
  /** Balance-changes view. /api/tx/record walks this to confirm the merchant
   * received >= the invoice canonical amount. */
  balanceChanges: NormalizedBalanceChange[];
  /** Flattened events, each with the outer digest injected. No verifier site
   * reads events today, but the field exists so 1.8+ event-scan helpers can
   * share the same shape. */
  events: NormalizedEvent[];
  /** RFC3339-derived ms-since-epoch. `null` if the response omitted it. */
  timestampMs: number | null;
  /** Sequence number string. `null` if the SDK omits it on the current
   * gRPC build (the patterns doc warns this is occasionally undefined). */
  checkpoint: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function lowerAddr(s: unknown): string | null {
  if (typeof s !== "string" || s.length === 0) return null;
  return s.toLowerCase();
}

function asBigInt(v: unknown, dflt = 0n): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && v.length > 0) {
    try {
      return BigInt(v);
    } catch {
      return dflt;
    }
  }
  return dflt;
}

function classifyGrpcOwner(owner: unknown): {
  kind: OwnerKind;
  address: string | null;
} {
  if (!owner || typeof owner !== "object") return { kind: "unknown", address: null };
  const o = owner as Record<string, unknown>;
  const k = (o.$kind ?? "") as string;
  switch (k) {
    case "AddressOwner":
      return { kind: "address", address: lowerAddr(o.AddressOwner) };
    case "ObjectOwner":
      return { kind: "object", address: lowerAddr(o.ObjectOwner) };
    case "Shared":
      return { kind: "shared", address: null };
    case "Immutable":
      return { kind: "immutable", address: null };
    case "ConsensusAddressOwner": {
      const inner = (o.ConsensusAddressOwner ?? {}) as Record<string, unknown>;
      return { kind: "address", address: lowerAddr(inner.owner) };
    }
    default:
      return { kind: "unknown", address: null };
  }
}

function classifyJsonRpcOwner(owner: unknown): {
  kind: OwnerKind;
  address: string | null;
} {
  if (owner === "Immutable") return { kind: "immutable", address: null };
  if (!owner || typeof owner !== "object") return { kind: "unknown", address: null };
  const o = owner as Record<string, unknown>;
  if (typeof o.AddressOwner === "string")
    return { kind: "address", address: lowerAddr(o.AddressOwner) };
  if (typeof o.ObjectOwner === "string")
    return { kind: "object", address: lowerAddr(o.ObjectOwner) };
  if (o.Shared) return { kind: "shared", address: null };
  if (o.Immutable) return { kind: "immutable", address: null };
  return { kind: "unknown", address: null };
}

function statusFromGrpc(s: unknown): {
  status: NormalizedExecutionStatus;
  errorMessage: string | null;
} {
  if (!s || typeof s !== "object") return { status: "failure", errorMessage: "unknown" };
  const obj = s as { success?: boolean; error?: unknown };
  if (obj.success === true) return { status: "success", errorMessage: null };
  // gRPC's `error` is a structured ExecutionError with `message` + extras;
  // we flatten the human-readable message out for the verifier's reason
  // string.
  let msg: string | null = null;
  if (obj.error && typeof obj.error === "object") {
    const e = obj.error as { message?: unknown };
    if (typeof e.message === "string") msg = e.message;
  } else if (typeof obj.error === "string") {
    msg = obj.error;
  }
  return { status: "failure", errorMessage: msg };
}

function classifyChangedObjectKind(
  idOperation: unknown,
  outputState: unknown
): NormalizedObjectChangeKind {
  if (idOperation === "Created") return "created";
  if (idOperation === "Deleted") return "deleted";
  // `None` covers both mutated existing objects and rewrites; the verifier
  // doesn't currently distinguish, but mutated is the most common shape.
  if (idOperation === "None") {
    if (outputState === "ObjectWrite" || outputState === "PackageWrite") return "mutated";
    return "other";
  }
  return "other";
}

// ─── gRPC normalizer ─────────────────────────────────────────────────────────

/**
 * Map a gRPC `core.getTransaction` response (with `include: { effects: true,
 * events: true, transaction: true, balanceChanges: true, objectTypes: true }`)
 * to the canonical shape.
 *
 * Pass the FULL response (the `{ $kind, Transaction, FailedTransaction }`
 * discriminated union). The helper picks the populated side automatically.
 */
export function normalizeFromGrpc(grpcResult: unknown): NormalizedTransaction {
  if (!grpcResult || typeof grpcResult !== "object") {
    throw new Error("normalizeFromGrpc: result is not an object");
  }
  const r = grpcResult as Record<string, unknown>;
  // Discriminated union — Onara-style. Either `Transaction` or
  // `FailedTransaction` is populated; the other is undefined.
  const inner = (r.Transaction ?? r.FailedTransaction) as
    | Record<string, unknown>
    | undefined;
  if (!inner) {
    throw new Error("normalizeFromGrpc: missing Transaction payload");
  }

  const digest = String(inner.digest ?? "");
  const outerStatus = statusFromGrpc(inner.status);

  const effects = (inner.effects ?? null) as Record<string, unknown> | null;
  const effectsStatus = effects ? statusFromGrpc(effects.status) : outerStatus;
  const gasUsed = effects?.gasUsed as
    | {
        computationCost?: string;
        storageCost?: string;
        storageRebate?: string;
        nonRefundableStorageFee?: string;
      }
    | undefined;

  // Transaction sub-block (sender + gas owner). Only populated when
  // `include.transaction === true`.
  const txData = (inner.transaction ?? null) as Record<string, unknown> | null;
  const sender = lowerAddr(txData?.sender) ?? "";
  const gasData = (txData?.gasData ?? null) as Record<string, unknown> | null;
  const gasOwner = lowerAddr(gasData?.owner) ?? sender;
  const gasBudget = asBigInt(gasData?.budget);
  const gasPrice = asBigInt(gasData?.price);

  // Balance changes — gRPC uses flat `{ address, coinType, amount }`.
  const balanceChangesRaw = (inner.balanceChanges ?? []) as Array<
    Record<string, unknown>
  >;
  const balanceChanges: NormalizedBalanceChange[] = balanceChangesRaw.map((c) => {
    const addr = lowerAddr(c.address);
    return {
      ownerKind: addr ? "address" : "unknown",
      ownerAddress: addr,
      coinType: typeof c.coinType === "string" ? c.coinType : "",
      amount: asBigInt(c.amount),
    };
  });

  // Object changes — gRPC build (as of @mysten/sui current) doesn't return
  // a separate `objectChanges[]` array. Instead, the per-row data lives in
  // `effects.changedObjects[]` with `idOperation` indicating create/delete/
  // mutate. We also pull types out of the optional `objectTypes` map (set
  // by `include.objectTypes`) when present.
  const changedObjects = (effects?.changedObjects ?? []) as Array<
    Record<string, unknown>
  >;
  const objectTypeMap = (inner.objectTypes ?? {}) as Record<string, string>;
  const objectChanges: NormalizedObjectChange[] = changedObjects.map((c) => {
    const kind = classifyChangedObjectKind(c.idOperation, c.outputState);
    const objectId = lowerAddr(c.objectId) ?? "";
    // Prefer the post-tx owner (`outputOwner`); fall back to pre-tx.
    const ownerSource = (c.outputOwner ?? c.inputOwner) as unknown;
    const owner = classifyGrpcOwner(ownerSource);
    return {
      kind,
      objectId,
      objectType: objectTypeMap[objectId] ?? null,
      ownerKind: ownerSource ? owner.kind : null,
      ownerAddress: owner.address,
    };
  });

  // Events — flatten the array and inject the outer digest into each event
  // (gRPC events don't carry their own `txDigest`; the patterns doc flags
  // this as a known shape gap).
  const eventsRaw = (inner.events ?? []) as Array<Record<string, unknown>>;
  const events: NormalizedEvent[] = eventsRaw.map((e) => ({
    txDigest: digest,
    packageId: typeof e.packageId === "string" ? e.packageId : "",
    module: typeof e.module === "string" ? e.module : "",
    sender: lowerAddr(e.sender) ?? "",
    eventType: typeof e.eventType === "string" ? e.eventType : "",
    bcs: e.bcs instanceof Uint8Array ? e.bcs : null,
    json: (e.json ?? null) as Record<string, unknown> | null,
  }));

  // Timestamp + checkpoint — both are optional on the current gRPC build;
  // patterns.md warns the SDK occasionally omits them.
  let timestampMs: number | null = null;
  const ts = inner.timestamp;
  if (typeof ts === "string" && ts.length > 0) {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) timestampMs = parsed;
  } else if (typeof ts === "number") {
    timestampMs = ts;
  }
  const checkpoint =
    typeof inner.checkpoint === "string" ? inner.checkpoint : null;

  return {
    digest,
    status: outerStatus.status,
    errorMessage: outerStatus.errorMessage,
    sender,
    gasOwner,
    gasBudget,
    gasPrice,
    effects: {
      status: effectsStatus.status,
      errorMessage: effectsStatus.errorMessage,
      gasUsed: gasUsed
        ? {
            computationCost: asBigInt(gasUsed.computationCost),
            storageCost: asBigInt(gasUsed.storageCost),
            storageRebate: asBigInt(gasUsed.storageRebate),
            nonRefundableStorageFee: asBigInt(gasUsed.nonRefundableStorageFee),
          }
        : null,
    },
    objectChanges,
    balanceChanges,
    events,
    timestampMs,
    checkpoint,
  };
}

// ─── JSON-RPC normalizer (legacy, migration window only) ─────────────────────

/**
 * Map a legacy JSON-RPC `getTransactionBlock` response to the canonical
 * shape. Exists ONLY for the Phase 1 migration window so verifier code can
 * be written once and consume either transport. Phase 5 deletes this — the
 * `@deprecated` tag makes it grep-able when the time comes.
 *
 * @deprecated Phase 5 removes the JSON-RPC client; this normalizer goes with
 *   it. Do not call from new code — use `getNormalizedTransaction()`.
 */
export function normalizeFromJsonRpc(jsonRpcResult: unknown): NormalizedTransaction {
  if (!jsonRpcResult || typeof jsonRpcResult !== "object") {
    throw new Error("normalizeFromJsonRpc: result is not an object");
  }
  const tx = jsonRpcResult as Record<string, unknown>;
  const digest = String(tx.digest ?? "");

  // status — JSON-RPC: `effects.status.status === "success"` (string), with
  // `.error` carrying the failure reason as a plain string.
  const effectsRaw = (tx.effects ?? null) as Record<string, unknown> | null;
  const statusBlock = (effectsRaw?.status ?? null) as Record<string, unknown> | null;
  const statusStr = statusBlock?.status;
  const errMsg =
    typeof statusBlock?.error === "string" ? (statusBlock.error as string) : null;
  const status: NormalizedExecutionStatus =
    statusStr === "success" ? "success" : "failure";

  // sender — JSON-RPC nests `transaction.data.sender`. The verifier code
  // calls into `tx.transaction?.data?.sender` directly today, so this
  // mirror is exactly how the legacy code reads it.
  const txInner = (tx.transaction ?? null) as Record<string, unknown> | null;
  const txDataInner = (txInner?.data ?? null) as Record<string, unknown> | null;
  const sender = lowerAddr(txDataInner?.sender) ?? "";

  const gasDataRaw = (txDataInner?.gasData ?? null) as Record<string, unknown> | null;
  const gasOwner = lowerAddr(gasDataRaw?.owner) ?? sender;
  const gasBudget = asBigInt(gasDataRaw?.budget);
  const gasPrice = asBigInt(gasDataRaw?.price);

  // Balance changes — JSON-RPC: `{ owner: { AddressOwner: "0x.." } |
  // { Shared } | "Immutable" | ..., coinType, amount }`.
  const balanceChangesRaw = (tx.balanceChanges ?? []) as Array<
    Record<string, unknown>
  >;
  const balanceChanges: NormalizedBalanceChange[] = balanceChangesRaw.map((c) => {
    const o = classifyJsonRpcOwner(c.owner);
    return {
      ownerKind: o.kind,
      ownerAddress: o.address,
      coinType: typeof c.coinType === "string" ? c.coinType : "",
      amount: asBigInt(c.amount),
    };
  });

  // Object changes — JSON-RPC: top-level `objectChanges[]` with
  // `type: "created" | "mutated" | "deleted" | "wrapped" | "transferred" |
  // "published"`.
  const objectChangesRaw = (tx.objectChanges ?? []) as Array<Record<string, unknown>>;
  const objectChanges: NormalizedObjectChange[] = objectChangesRaw.map((c) => {
    const t = typeof c.type === "string" ? c.type.toLowerCase() : "other";
    let kind: NormalizedObjectChangeKind;
    switch (t) {
      case "created":
      case "mutated":
      case "deleted":
        kind = t;
        break;
      default:
        kind = "other";
    }
    const owner = classifyJsonRpcOwner(c.owner);
    return {
      kind,
      objectId: lowerAddr(c.objectId) ?? "",
      objectType: typeof c.objectType === "string" ? c.objectType : null,
      ownerKind: c.owner !== undefined ? owner.kind : null,
      ownerAddress: owner.address,
    };
  });

  // Events — JSON-RPC: `{ id: { txDigest, eventSeq }, packageId,
  // transactionModule, sender, type, parsedJson, bcs }`. We rename to the
  // canonical shape so callers see the same field set regardless of
  // transport.
  const eventsRaw = (tx.events ?? []) as Array<Record<string, unknown>>;
  const events: NormalizedEvent[] = eventsRaw.map((e) => {
    const id = (e.id ?? null) as Record<string, unknown> | null;
    const evTxDigest = typeof id?.txDigest === "string" ? (id.txDigest as string) : digest;
    let bcs: Uint8Array | null = null;
    if (e.bcs instanceof Uint8Array) bcs = e.bcs;
    return {
      txDigest: evTxDigest,
      packageId: typeof e.packageId === "string" ? e.packageId : "",
      module:
        typeof e.transactionModule === "string" ? (e.transactionModule as string) : "",
      sender: lowerAddr(e.sender) ?? "",
      eventType: typeof e.type === "string" ? (e.type as string) : "",
      bcs,
      json: (e.parsedJson ?? null) as Record<string, unknown> | null,
    };
  });

  let timestampMs: number | null = null;
  if (typeof tx.timestampMs === "string" && tx.timestampMs.length > 0) {
    const n = Number(tx.timestampMs);
    if (Number.isFinite(n)) timestampMs = n;
  } else if (typeof tx.timestampMs === "number") {
    timestampMs = tx.timestampMs;
  }

  const checkpoint =
    typeof tx.checkpoint === "string" ? (tx.checkpoint as string) : null;

  return {
    digest,
    status,
    errorMessage: errMsg,
    sender,
    gasOwner,
    gasBudget,
    gasPrice,
    effects: {
      status,
      errorMessage: errMsg,
      gasUsed: null, // JSON-RPC nests under `effects.gasUsed` with same keys
      // — but no verifier reads it today. If a future caller needs it, lift
      // here and mirror the gRPC keys.
    },
    objectChanges,
    balanceChanges,
    events,
    timestampMs,
    checkpoint,
  };
}

// ─── Public fetch helper ─────────────────────────────────────────────────────

/**
 * Fetch + normalize a transaction by digest using the canonical gRPC client.
 *
 * This is the only function verifier code should call. Internally it requests
 * the full include-set the four verifier sites need:
 *
 *   • `effects` — status + gas + changedObjects (object-change verification).
 *   • `events` — currently unused by verifiers, included anyway so future
 *     event-aware checks don't need a second round-trip.
 *   • `transaction` — sender + gasData. Without this `tx.sender` is empty.
 *   • `balanceChanges` — for /api/tx/record's merchant-received check.
 *   • `objectTypes` — gives us the type tag for each changed object, which
 *     the vault verifier needs to confirm the new object is a `TaliseVault`.
 */
export async function getNormalizedTransaction(
  digest: string
): Promise<NormalizedTransaction> {
  if (typeof digest !== "string" || digest.length === 0) {
    throw new Error("getNormalizedTransaction: digest required");
  }
  const res = await sui().getTransaction({
    digest,
    include: {
      effects: true,
      events: true,
      transaction: true,
      balanceChanges: true,
      objectTypes: true,
    },
  });
  return normalizeFromGrpc(res);
}
