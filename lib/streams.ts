import "server-only";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { db, ensureSchema, schemaVersionGate } from "@/lib/db";
import { sui } from "@/lib/sui";
import { USDSUI_TYPE } from "@/lib/usdsui";
import { onara } from "@/lib/onara";
import { getNormalizedTransaction } from "@/lib/sui-shapes";
import { resolveDisplayNames, type DisplayNames } from "@/lib/display-name";

/**
 * Streaming USDsui payments, backend data layer.
 *
 * THERE IS NO SCHEDULER. A stream is a real shared `Stream<USDSUI>` Move
 * object (`move/talise/sources/stream.move`) holding the full amount as a
 * `Balance<USDSUI>`, and the on-chain `Clock` decides what is due. Money moves
 * when someone calls the PERMISSIONLESS `stream::claim_accrued`, which walks
 * the schedule and hard-transfers every due tranche to the stream's hardwired
 * `recipient`. Because the destination is fixed at create time, ANY party can
 * push a stream forward and the funds can only ever land on the recipient, so
 * both the recipient's app AND the sender's app fire due claims on open
 * (mirroring the money-rules trigger). That is what makes it actually stream.
 *
 * TRUTH MODEL. Two different questions, kept strictly apart:
 *
 *   • ACCRUED — what the Clock has earned. Pure schedule arithmetic
 *     (`accruedTranches`), identical to the contract's own `due_at` walk.
 *   • RELEASED — what has actually reached the recipient's wallet. ONLY ever
 *     mirrored from the contract's own `tranches_done` / `released_amount`
 *     cursors (`readOnchainStream` → `syncStreamFromChain`). Never inferred
 *     from the schedule, because an accrued-but-unclaimed tranche is still
 *     sitting in the Stream object's escrow.
 *
 * The UI shows RELEASED as progress and ACCRUED only as "ready to claim", so
 * no figure is shown that the chain does not back.
 *
 * `completed` is DERIVED (`derivedStreamState`), never stored: with no
 * scheduler there is nothing to write it, so deriving it from the contract
 * cursor is what keeps the card correct.
 *
 * Legacy: `STREAM_ESCROW_SK` / `streamEscrowEnabled()` are the retired
 * escrow + cron rail, kept only so old `str_…` rows still read cleanly.
 *
 * µUSDsui = BIGINT, 6 decimals.
 */

// ── Escrow keypair (mirror web/lib/suins-operator.ts operator()) ────────
let _escrow: Ed25519Keypair | null = null;

/** True when the server holds an escrow keypair and the feature can run. */
export function streamEscrowEnabled(): boolean {
  return !!process.env.STREAM_ESCROW_SK;
}

/**
 * The published `talise::stream` package id, when configured. The escrow +
 * scheduler variant does NOT need it, it is the seam for the future
 * on-chain `Stream` object path. Returns null (feature gated off) when unset
 * so an absent id never breaks anything.
 */
export function streamPackageId(): string | null {
  return process.env.STREAM_PACKAGE_ID ?? null;
}

/**
 * The shared `StreamRegistry` object id, when configured. Required (alongside
 * the package id) to build any on-chain stream PTB.
 */
export function streamRegistryId(): string | null {
  return process.env.STREAM_REGISTRY_ID ?? null;
}

/**
 * True when the on-chain `talise::stream` path is configured, just the
 * package + registry ids. It does NOT require a worker/escrow key: streaming
 * is cron-less now, the recipient pulls accrued tranches via the permissionless
 * `stream::claim_accrued` (Onara-sponsored), `create` is sponsored, and
 * `cancel_and_withdraw` is sender-signed. None of those need a server key.
 * This is the ONE gate every on-chain branch checks; create-prepare 503s when
 * it's false (the escrow + scheduler rail is retired).
 */
export function streamOnchainEnabled(): boolean {
  return (
    !!process.env.STREAM_PACKAGE_ID &&
    !!process.env.STREAM_REGISTRY_ID
  );
}

/** Fully-qualified on-chain Stream object type prefix: `${PKG}::stream::Stream<`. */
function streamObjectTypePrefix(pkg: string): string {
  return `${pkg}::stream::Stream<`;
}

/** The shared Sui Clock object id (immutable, network-wide). */
const SUI_CLOCK_ID = "0x6";

/** Load the server escrow Ed25519 keypair. Throws when `STREAM_ESCROW_SK` unset. */
function escrowKeypair(): Ed25519Keypair {
  if (_escrow) return _escrow;
  const k = process.env.STREAM_ESCROW_SK;
  if (!k) {
    throw new Error(
      "STREAM_ESCROW_SK missing, the Talise-controlled escrow keypair that holds streamed funds"
    );
  }
  _escrow = Ed25519Keypair.fromSecretKey(k);
  return _escrow;
}

/** The escrow's Sui address, the funding destination for every stream. */
export function streamEscrowAddress(): string {
  return escrowKeypair().getPublicKey().toSuiAddress();
}

// ── Schema (self-bootstrapping, memoized once-per-process) ──────────────
// Mirrors web/lib/send-limits.ts ensureLedgerSchema discipline: a
// once-per-process promise that resets on failure so a transient error
// retries. Postgres DDL (SERIAL / BIGINT / TEXT / partial + unique index /
// ON CONFLICT). Schema per the design (§5).
let _schemaReadyP: Promise<void> | null = null;

// Bump whenever ANY DDL below changes, the one-SELECT version gate skips the
// replay (~8 round-trips) on every cold start while the marker matches.
const STREAMS_SCHEMA_VERSION = "2026-06-10.1";

export function ensureStreamsSchema(): Promise<void> {
  if (_schemaReadyP) return _schemaReadyP;
  _schemaReadyP = (async () => {
    await ensureSchema();
    const c = db();

    const gate = await schemaVersionGate("streams_schema_version", STREAMS_SCHEMA_VERSION);
    if (gate.upToDate) return;
    // One row per stream. The escrow holds the undistributed funds; this
    // row is the scheduler index + UI cache. `id` is the stream id, the
    // on-chain Stream object id when STREAM_PACKAGE_ID is live, otherwise a
    // server-generated "str_<hex>" id for the escrow variant.
    await c.execute(
      `CREATE TABLE IF NOT EXISTS streams (
        id                  TEXT PRIMARY KEY,
        sender_user_id      INTEGER NOT NULL,
        sender_address      TEXT NOT NULL,
        recipient_address   TEXT NOT NULL,
        recipient_handle    TEXT,
        total_micros        BIGINT NOT NULL,
        tranche_micros      BIGINT NOT NULL,
        num_tranches        BIGINT NOT NULL,
        tranches_done       BIGINT NOT NULL DEFAULT 0,
        released_micros     BIGINT NOT NULL DEFAULT 0,
        start_ms            BIGINT NOT NULL,
        interval_ms         BIGINT NOT NULL,
        next_tranche_at     BIGINT NOT NULL,
        state               TEXT NOT NULL DEFAULT 'active',
        funding_digest      TEXT NOT NULL,
        last_tranche_digest TEXT,
        last_tranche_at     BIGINT,
        attempt_count       INTEGER NOT NULL DEFAULT 0,
        lease_until         BIGINT,
        lease_owner         TEXT,
        created_at          BIGINT NOT NULL,
        updated_at          BIGINT NOT NULL
      )`
    );
    // Hot scheduler read: active streams with a tranche due now.
    await c.execute(
      `CREATE INDEX IF NOT EXISTS idx_streams_due
         ON streams (next_tranche_at)
         WHERE state = 'active'`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS idx_streams_sender
         ON streams (sender_user_id, created_at DESC)`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS idx_streams_recipient
         ON streams (recipient_address, created_at DESC)`
    );
    // Append-only per-tranche ledger. The unique index is the DB-side
    // idempotency guard (a retried success-write is a no-op via ON CONFLICT).
    await c.execute(
      `CREATE TABLE IF NOT EXISTS stream_tranches (
        id            SERIAL PRIMARY KEY,
        stream_id     TEXT NOT NULL,
        tranche_index BIGINT NOT NULL,
        amount_micros BIGINT NOT NULL,
        tx_digest     TEXT,
        paid_at       BIGINT NOT NULL
      )`
    );
    await c.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_stream_tranche
         ON stream_tranches (stream_id, tranche_index)`
    );

    await gate.stamp();
  })().catch((err) => {
    _schemaReadyP = null;
    throw err;
  });
  return _schemaReadyP;
}

// ── Types ───────────────────────────────────────────────────────────────
export type StreamState =
  | "active"
  | "paused"
  | "completed"
  | "cancelled"
  | "stalled";

export interface StreamRow {
  id: string;
  sender_user_id: number;
  sender_address: string;
  recipient_address: string;
  recipient_handle: string | null;
  total_micros: number;
  tranche_micros: number;
  num_tranches: number;
  tranches_done: number;
  released_micros: number;
  start_ms: number;
  interval_ms: number;
  next_tranche_at: number;
  state: StreamState;
  funding_digest: string;
  last_tranche_digest: string | null;
  last_tranche_at: number | null;
  attempt_count: number;
  lease_until: number | null;
  lease_owner: string | null;
  created_at: number;
  updated_at: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Generate a server-side stream id for the escrow variant (no on-chain object). */
export function newStreamId(): string {
  return `str_${randomHex(24)}`;
}

/**
 * True when a stream id is a real on-chain `Stream<T>` object id (`0x…`) vs a
 * synthetic escrow id (`str_…`). The cron uses this to pick the on-chain
 * release path vs the escrow→recipient transfer path. On-chain object ids are
 * 0x-prefixed 64-hex; escrow ids are `str_<hex>`.
 */
export function isOnchainStreamId(id: string): boolean {
  return /^0x[a-f0-9]{1,64}$/i.test(id);
}

function randomHex(bytes: number): string {
  // crypto.randomBytes via Web Crypto (available on the Node/Vercel runtime).
  const arr = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Insert a new stream row. State starts `active`; the FIRST tranche fires at
 * `start_ms` so `next_tranche_at = start_ms` (tranches_done = 0).
 */
export async function createStreamRecord(input: {
  id: string;
  senderUserId: number;
  senderAddress: string;
  recipientAddress: string;
  recipientHandle: string | null;
  totalMicros: bigint;
  trancheMicros: bigint;
  numTranches: number;
  startMs: number;
  intervalMs: number;
  fundingDigest: string;
}): Promise<void> {
  await ensureStreamsSchema();
  const now = Date.now();
  await db().execute({
    sql: `INSERT INTO streams
            (id, sender_user_id, sender_address, recipient_address,
             recipient_handle, total_micros, tranche_micros, num_tranches,
             tranches_done, released_micros, start_ms, interval_ms,
             next_tranche_at, state, funding_digest, attempt_count,
             created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 'active', ?, 0, ?, ?)
          ON CONFLICT (id) DO NOTHING`,
    args: [
      input.id,
      input.senderUserId,
      input.senderAddress,
      input.recipientAddress,
      input.recipientHandle,
      input.totalMicros.toString(),
      input.trancheMicros.toString(),
      input.numTranches,
      input.startMs,
      input.intervalMs,
      input.startMs,
      input.fundingDigest,
      now,
      now,
    ],
  });
}

/** A single stream by id (any state). */
export async function streamById(id: string): Promise<StreamRow | null> {
  await ensureStreamsSchema();
  const r = await db().execute({
    sql: "SELECT * FROM streams WHERE id = ? LIMIT 1",
    args: [id],
  });
  return (r.rows[0] as unknown as StreamRow) ?? null;
}

/** All streams where the user is the SENDER, or the recipient matches their address. */
export async function streamsForUser(
  userId: number,
  recipientAddress: string
): Promise<StreamRow[]> {
  await ensureStreamsSchema();
  const r = await db().execute({
    sql: `SELECT * FROM streams
           WHERE sender_user_id = ? OR LOWER(recipient_address) = LOWER(?)
           ORDER BY created_at DESC
           LIMIT 200`,
    args: [userId, recipientAddress],
  });
  return r.rows as unknown as StreamRow[];
}

/** Flip a stream's state (pause/resume/cancel/stalled). */
export async function setStreamState(id: string, state: StreamState): Promise<void> {
  await ensureStreamsSchema();
  await db().execute({
    sql: `UPDATE streams SET state = ?, lease_until = NULL, lease_owner = NULL, updated_at = ? WHERE id = ?`,
    args: [state, Date.now(), id],
  });
}

// ── The chain is the source of truth for RELEASED ────────────────────────

/** The subset of the live `Stream<T>` object the mirror tracks. */
export interface OnchainStreamState {
  /** The contract's release cursor. Incremented in the SAME tx that transfers
   *  the tranche, so it can never overstate what the recipient received. */
  tranchesDone: number;
  /** Cumulative µUSDsui actually transferred to the recipient. */
  releasedMicros: number;
  /** µUSDsui still locked in the Stream object (refundable on cancel). */
  escrowMicros: number;
  paused: boolean;
  cancelled: boolean;
}

/** Move `u64` json comes back as a decimal string over gRPC. */
function u64(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.trunc(v));
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return 0;
}

/**
 * Read the live `Stream<USDSUI>` object's cursors. This is the ONLY authority
 * on how much money has actually landed: `released_amount` is bumped by the
 * contract inside the very tx that transfers the tranche.
 *
 * Never throws — returns null when the object can't be read, so every caller
 * degrades to the stored mirror rather than failing a page load.
 */
export async function readOnchainStream(
  streamObjectId: string
): Promise<OnchainStreamState | null> {
  if (!isOnchainStreamId(streamObjectId)) return null;
  try {
    const res = await (
      sui() as unknown as {
        getObject: (a: {
          objectId: string;
          include: { json: boolean };
        }) => Promise<{ object?: { json?: Record<string, unknown> | null } | null }>;
      }
    ).getObject({ objectId: streamObjectId, include: { json: true } });
    const json = res.object?.json;
    if (!json || typeof json !== "object") return null;
    // Refuse to interpret a shape we don't recognise. Without this a renamed or
    // missing field would read as `tranches_done: 0` and be indistinguishable
    // from an untouched stream, so the mirror would never advance and every
    // screen-open would fire another (harmless but pointless) sponsored claim.
    // `total_amount` and `num_tranches` are set at create and never zero, so
    // their absence means the read is not a Stream we can trust.
    if (u64(json.total_amount) === 0 || u64(json.num_tranches) === 0) return null;
    // `escrow` is a Balance<T>, whose json is `{ value: "…" }`.
    const escrow = json.escrow as { value?: unknown } | string | undefined;
    return {
      tranchesDone: u64(json.tranches_done),
      releasedMicros: u64(json.released_amount),
      escrowMicros: u64(
        typeof escrow === "object" && escrow !== null ? escrow.value : escrow
      ),
      paused: json.paused === true,
      cancelled: json.cancelled === true,
    };
  } catch {
    return null;
  }
}

/**
 * Fold a chain read into the stored row and persist it. Monotonic on the
 * release cursors (the contract's are too), so a stale read can never walk a
 * mirror backwards.
 *
 * State rules, each in the SAFE direction:
 *   • chain cancelled/paused → mirror follows (stops the auto-fire trigger).
 *   • chain says neither, but the mirror says `cancelled` → STAY cancelled.
 *     The cancel route flips the row before the sender signs the withdraw, and
 *     suppressing further claims while that signature is pending is the
 *     conservative choice: the money simply stays locked and refundable.
 *   • otherwise → active. This is how a confirmed on-chain resume un-pauses.
 */
async function applyOnchainStreamState(
  row: StreamRow,
  chain: OnchainStreamState
): Promise<StreamRow> {
  const num = Number(row.num_tranches);
  const total = Number(row.total_micros);
  const tranchesDone = Math.min(num, Math.max(Number(row.tranches_done) || 0, chain.tranchesDone));
  const releasedMicros = Math.min(
    total,
    Math.max(Number(row.released_micros) || 0, chain.releasedMicros)
  );
  const state: StreamState = chain.cancelled
    ? "cancelled"
    : chain.paused
      ? "paused"
      : row.state === "cancelled"
        ? "cancelled"
        : "active";
  const nextTrancheAt = Number(row.start_ms) + tranchesDone * Number(row.interval_ms);
  const now = Date.now();

  const unchanged =
    tranchesDone === Number(row.tranches_done) &&
    releasedMicros === Number(row.released_micros) &&
    state === row.state;
  if (unchanged) return row;

  await db().execute({
    sql: `UPDATE streams
             SET tranches_done = ?, released_micros = ?, state = ?,
                 next_tranche_at = ?, last_tranche_at = ?, updated_at = ?
           WHERE id = ?`,
    args: [
      tranchesDone,
      releasedMicros.toString(),
      state,
      nextTrancheAt,
      tranchesDone > Number(row.tranches_done) ? now : row.last_tranche_at,
      now,
      row.id,
    ],
  });

  // Append-only per-tranche ledger. The unique (stream_id, tranche_index)
  // index makes a replayed sync a no-op, so this can never double-count.
  for (let idx = Number(row.tranches_done) + 1; idx <= tranchesDone; idx++) {
    const amount = trancheMicrosFor(row, idx) - trancheMicrosFor(row, idx - 1);
    await db().execute({
      sql: `INSERT INTO stream_tranches (stream_id, tranche_index, amount_micros, paid_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT DO NOTHING`,
      args: [row.id, idx, Math.max(0, amount).toString(), now],
    });
  }

  return { ...row, tranches_done: tranchesDone, released_micros: releasedMicros, state, next_tranche_at: nextTrancheAt };
}

/**
 * Pull the contract's cursors into the mirror. `retries` re-reads with short
 * backoff, for the moment right after a claim/pause/cancel tx when the
 * fullnode may not have surfaced the new object version yet; it stops as soon
 * as the read differs from what's stored.
 *
 * Best-effort: on an unreadable object the stored row comes back untouched.
 */
export async function syncStreamFromChain(
  id: string,
  opts: { retries?: number } = {}
): Promise<StreamRow | null> {
  const row = await streamById(id);
  if (!row) return null;
  if (!isOnchainStreamId(id)) return row;

  const delays = [0, 700, 1500].slice(0, Math.max(1, (opts.retries ?? 0) + 1));
  let last: OnchainStreamState | null = null;
  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const chain = await readOnchainStream(id);
    if (!chain) continue;
    last = chain;
    const moved =
      chain.tranchesDone > (Number(row.tranches_done) || 0) ||
      chain.cancelled !== (row.state === "cancelled") ||
      chain.paused !== (row.state === "paused");
    if (moved) break;
  }
  if (!last) return row;
  return applyOnchainStreamState(row, last);
}

/**
 * Record a CONFIRMED stream tx (a claim, a pause, a resume or a cancel) by
 * re-reading the contract. There is deliberately no digest-trust here: we
 * write only what the on-chain object reports, so a bogus digest can't move
 * the mirror by a single micro. The digest is used purely to know a tx just
 * landed and therefore to retry the read.
 *
 * If every read still comes back stale the mirror simply stays behind, which is
 * self-healing rather than wrong: `dueNow` stays true, the next screen-open
 * fires one more claim (a no-op on chain if there is nothing left), and that
 * confirm picks up the settled cursor.
 */
export async function recordStreamTx(id: string, digest: string): Promise<StreamRow | null> {
  return syncStreamFromChain(id, { retries: digest ? 2 : 0 });
}

// ════════════════════════════════════════════════════════════════════════
// ON-CHAIN `talise::stream` PTB BUILDERS.
//
// Every one is Onara-SPONSORED and user-signed: a custom Move call is NOT
// gasless-eligible (only 0x2::balance::send_funds is), so Onara owns the gas
// and the user signs the sender slot. Shape mirrors the SPONSORED branch of
// /api/send/sponsor-prepare: onara().status() for the sponsor address +
// reference gas price, setSender(user), setGasOwner(sponsor), setGasPrice,
// setGasBudget, build → sponsor-ready bytes the client signs and POSTs to
// /api/zk/sponsor-execute. NO server key is involved anywhere.
//
// The contract ABI the builders target:
//   create<T>(registry, funds: Balance<T>, recipient, tranche_amount,
//             num_tranches, start_ms, interval_ms, clock, ctx): ID
//   claim_accrued<T>(stream, clock, ctx)          // PERMISSIONLESS
//   pause<T>(stream, ctx) / resume<T>(stream, ctx) // sender-only
//   cancel_and_withdraw<T>(stream, ctx): Coin<T>   // sender-only
//
// SETTLE-BEFORE-STOP. `pause` and `cancel_and_withdraw` each COMPOSE
// `claim_accrued` ahead of themselves in the same PTB. Without that, stopping
// a stream would claw back tranches the Clock had already earned the recipient
// (they sit unclaimed in the object's escrow and `cancel_and_withdraw` refunds
// the lot to the sender). Composing makes stopping atomic and honest: the
// recipient keeps everything due, the sender is refunded exactly the rest, and
// the frozen figure on the card is the same number the chain holds.
//
// The one exception is an ALREADY-paused stream: `claim_accrued` aborts on
// `EPaused`, so the cancel of a paused stream must not compose it (nothing new
// could have become claimable while paused anyway).
// ════════════════════════════════════════════════════════════════════════

/**
 * Sponsor scaffolding shared by every sender-signed control PTB. The explicit
 * gas budget matters: without it the built bytes carry none and execution
 * fails with InsufficientGas (the same trap `create` documents). Only the gas
 * actually consumed is charged to the sponsor.
 */
async function buildSponsored(
  senderAddress: string,
  fill: (tx: Transaction) => void,
  gasBudget = 60_000_000n
): Promise<{ bytes: string; sponsor: string }> {
  const client = sui();
  const [{ address: sponsor }, gasPrice] = await Promise.all([
    onara().status(),
    client.getReferenceGasPrice().then((r) => r.referenceGasPrice),
  ]);

  const tx = new Transaction();
  tx.setSender(senderAddress);
  fill(tx);
  tx.setGasOwner(sponsor);
  tx.setGasPrice(BigInt(gasPrice));
  tx.setGasBudget(gasBudget);

  const bytes = await tx.build({ client: client as never });
  return { bytes: toBase64(bytes), sponsor };
}

/**
 * Build the Onara-SPONSORED `talise::stream::create<USDSUI>` PTB. The user
 * signs; Onara sponsors gas. The `funds` argument is pulled from the user's
 * Address Balance accumulator via `tx.balance(...)` (the same primitive the
 * gasless send rail uses), so no Coin<USDSUI> object is required.
 *
 * Returns sponsor-ready base64 bytes that iOS signs and POSTs to
 * /api/zk/sponsor-execute. Throws on build failure (the caller categorizes).
 *
 * Requires streamOnchainEnabled() upstream (caller gates).
 */
export async function buildStreamCreateSponsored(input: {
  senderAddress: string;
  recipientAddress: string;
  totalMicros: bigint;
  trancheMicros: bigint;
  numTranches: number;
  startMs: number;
  intervalMs: number;
}): Promise<{ bytes: string; sponsor: string }> {
  const pkg = streamPackageId();
  const registry = streamRegistryId();
  if (!pkg || !registry) {
    throw new Error(
      "STREAM_PACKAGE_ID / STREAM_REGISTRY_ID unset, on-chain stream create disabled"
    );
  }

  const onaraClient = onara();
  const client = sui();

  // Sponsor address + reference gas price in parallel (same as sponsor-prepare).
  const [{ address: sponsor }, gasPrice] = await Promise.all([
    onaraClient.status(),
    client.getReferenceGasPrice().then((r) => r.referenceGasPrice),
  ]);

  const tx = new Transaction();
  tx.setSender(input.senderAddress);

  // stream::create wants a Balance<USDSUI>. Source it from WHEREVER the user's
  // USDsui actually lives:
  //   • Coin<USDSUI> objects (the common case, received funds, on-ramp, swaps)
  //     → coinWithBalance({useGasCoin:false}) auto-merges/splits owned coins,
  //       then coin::into_balance converts Coin → Balance. Same primitive every
  //       other Talise contract-funding flow uses (goal vault, sponsored send).
  //   • Address-Balance accumulator → tx.balance (the gasless-send rail).
  // Using ONLY the accumulator (the old behaviour) aborted on execution for any
  // user whose funds were in coins, which is most of them, hence "couldn't
  // start the stream". Pick by summing the user's coin objects.
  let coinTotal = 0n;
  try {
    const res = await (client as unknown as {
      listCoins: (a: { owner: string; coinType: string }) => Promise<{
        objects?: Array<{ balance?: string }>;
      }>;
    }).listCoins({ owner: input.senderAddress, coinType: USDSUI_TYPE });
    for (const o of res.objects ?? []) coinTotal += BigInt(o.balance ?? "0");
  } catch {
    // listCoins read failed, fall through to the accumulator path.
  }

  const funds =
    coinTotal >= input.totalMicros
      ? tx.moveCall({
          target: "0x2::coin::into_balance",
          typeArguments: [USDSUI_TYPE],
          arguments: [
            tx.add(
              coinWithBalance({
                type: USDSUI_TYPE,
                balance: input.totalMicros,
                useGasCoin: false,
              })
            ),
          ],
        })
      : tx.balance({ type: USDSUI_TYPE, balance: input.totalMicros });

  tx.moveCall({
    target: `${pkg}::stream::create`,
    typeArguments: [USDSUI_TYPE],
    arguments: [
      tx.object(registry),
      funds,
      tx.pure.address(input.recipientAddress),
      tx.pure.u64(input.trancheMicros),
      tx.pure.u64(BigInt(input.numTranches)),
      tx.pure.u64(BigInt(input.startMs)),
      tx.pure.u64(BigInt(input.intervalMs)),
      tx.object(SUI_CLOCK_ID),
    ],
  });

  // SPONSORED: Onara owns the gas. The user signs the sender slot.
  tx.setGasOwner(sponsor);
  tx.setGasPrice(BigInt(gasPrice));
  // Explicit budget (0.06 SUI), without it the built bytes carry no gas
  // budget and execution fails with InsufficientGas. Same fixed budget the
  // goal-vault + send sponsored builders use; only the gas actually consumed
  // is charged to the sponsor.
  tx.setGasBudget(60_000_000n);

  const bytes = await tx.build({ client: client as never });
  return { bytes: toBase64(bytes), sponsor };
}

/**
 * Gas budget for a `claim_accrued` call. The contract releases EVERY due
 * tranche in one loop, so a stream nobody has touched for a long time needs
 * room for many transfers in a single tx — a flat budget would abort with
 * InsufficientGas exactly when a stream most needs pushing. Scales with the
 * backlog, capped so a runaway schedule can't hand the sponsor a huge bill.
 */
function claimGasBudget(claimableTranches: number): bigint {
  const n = BigInt(Math.max(1, Math.min(400, claimableTranches)));
  const budget = 30_000_000n + 5_000_000n * n;
  return budget > 1_000_000_000n ? 1_000_000_000n : budget;
}

/**
 * Build the Onara-SPONSORED `talise::stream::claim_accrued<USDSUI>` PTB.
 *
 * THIS is the cron-less release path, and it is what actually makes a stream
 * stream. `claim_accrued` is permissionless on chain: it walks the schedule,
 * releases EVERY tranche whose Clock due-time has passed, and transfers it to
 * the stream's hardwired `recipient`, so there is no extraction surface (a
 * caller can only push DUE funds to the recipient, never to themselves, never
 * more than the schedule allows). Because of that, EITHER party's app opening
 * can advance the stream — the recipient's and the sender's alike — and Onara
 * sponsors the gas so it is free for whoever fires it.
 *
 * The contract is the real gate (it aborts on `ECancelled` / `EPaused`, and a
 * nothing-due call is simply a no-op), so callers treat this as best-effort.
 *
 * Requires streamOnchainEnabled() upstream (caller gates).
 */
export async function buildClaimAccruedSponsored(input: {
  /** The on-chain `Stream<USDSUI>` object id (== the stream's DB id). */
  streamObjectId: string;
  /** The signer, either party. Funds always go to the contract-hardwired
   *  recipient regardless of who signs. */
  signerAddress: string;
  /** How many tranches are due, for gas sizing. */
  claimableTranches?: number;
}): Promise<{ bytes: string; sponsor: string }> {
  const pkg = streamPackageId();
  if (!pkg) {
    throw new Error("STREAM_PACKAGE_ID unset, on-chain stream claim disabled");
  }

  return buildSponsored(
    input.signerAddress,
    (tx) => {
      tx.moveCall({
        target: `${pkg}::stream::claim_accrued`,
        typeArguments: [USDSUI_TYPE],
        arguments: [tx.object(input.streamObjectId), tx.object(SUI_CLOCK_ID)],
      });
    },
    claimGasBudget(input.claimableTranches ?? 1)
  );
}

/**
 * Build the Onara-SPONSORED PAUSE PTB: settle everything the Clock has already
 * earned the recipient, THEN pause. Sender-signed (the contract asserts
 * `ctx.sender() == stream.sender`).
 *
 * Pausing is not a clawback: tranches whose due-time has passed belong to the
 * recipient, so `claim_accrued` runs first in the same PTB. After this lands,
 * the contract's `released_amount` equals what the Clock had accrued, which is
 * exactly the figure the paused card freezes on.
 */
export async function buildStreamPauseSponsored(input: {
  senderAddress: string;
  streamObjectId: string;
  claimableTranches?: number;
}): Promise<{ bytes: string; sponsor: string }> {
  const pkg = streamPackageId();
  if (!pkg) {
    throw new Error("STREAM_PACKAGE_ID unset, on-chain stream pause disabled");
  }

  return buildSponsored(
    input.senderAddress,
    (tx) => {
      tx.moveCall({
        target: `${pkg}::stream::claim_accrued`,
        typeArguments: [USDSUI_TYPE],
        arguments: [tx.object(input.streamObjectId), tx.object(SUI_CLOCK_ID)],
      });
      tx.moveCall({
        target: `${pkg}::stream::pause`,
        typeArguments: [USDSUI_TYPE],
        arguments: [tx.object(input.streamObjectId)],
      });
    },
    claimGasBudget(input.claimableTranches ?? 1)
  );
}

/**
 * Build the Onara-SPONSORED RESUME PTB. Sender-signed. The schedule keeps its
 * ORIGINAL timing, so a long pause leaves several tranches immediately due; the
 * next auto-fire claim drains them in one call.
 */
export async function buildStreamResumeSponsored(input: {
  senderAddress: string;
  streamObjectId: string;
}): Promise<{ bytes: string; sponsor: string }> {
  const pkg = streamPackageId();
  if (!pkg) {
    throw new Error("STREAM_PACKAGE_ID unset, on-chain stream resume disabled");
  }

  return buildSponsored(input.senderAddress, (tx) => {
    tx.moveCall({
      target: `${pkg}::stream::resume`,
      typeArguments: [USDSUI_TYPE],
      arguments: [tx.object(input.streamObjectId)],
    });
  });
}

/**
 * Parse the CREATED `Stream<...>` object id out of a confirmed funding tx.
 * The create PTB shares exactly one `${PKG}::stream::Stream<USDSUI>` object;
 * its objectId IS the on-chain stream id we persist as `streams.id`.
 *
 * Reads via `getNormalizedTransaction(digest)` (gRPC, with objectTypes) so we
 * don't depend on the sponsor-execute response carrying objectChanges (it
 * doesn't on the gRPC build).
 *
 * The record call lands milliseconds after execution returns the digest, and
 * fullnode reads often lag indexing by 1–3s, so a single read here used to
 * 409 every freshly-funded stream ("Couldn't confirm the on-chain stream
 * yet") even though the money had already moved. We now retry the read with
 * short backoff (~7s budget) before giving up. Returns null only if the tx
 * stays unreadable, genuinely failed, or created no Stream object (the
 * caller surfaces a clean error instead of persisting a synthetic id).
 */
export async function parseCreatedStreamObjectId(
  digest: string
): Promise<string | null> {
  const pkg = streamPackageId();
  if (!pkg) return null;
  const prefix = streamObjectTypePrefix(pkg).toLowerCase();

  const DELAYS_MS = [0, 800, 1200, 2000, 3000];
  for (let attempt = 0; attempt < DELAYS_MS.length; attempt++) {
    if (DELAYS_MS[attempt] > 0) {
      await new Promise((r) => setTimeout(r, DELAYS_MS[attempt]));
    }

    let tx;
    try {
      tx = await getNormalizedTransaction(digest);
    } catch (err) {
      // Most likely "not found", the node hasn't indexed the digest yet.
      console.warn(
        `[streams] parseCreatedStreamObjectId getTransaction failed (attempt ${attempt + 1}/${DELAYS_MS.length}) digest=${digest}: ${(err as Error).message}`
      );
      continue;
    }
    // A readable failed tx will never produce the object, stop retrying.
    if (tx.status !== "success") return null;

    for (const oc of tx.objectChanges) {
      if (oc.kind !== "created") continue;
      const ty = (oc.objectType ?? "").toLowerCase();
      if (ty.startsWith(prefix)) {
        return oc.objectId;
      }
    }
    // Readable + successful but no Stream object, retrying won't change it.
    return null;
  }
  return null;
}

/**
 * Build the Onara-SPONSORED CANCEL PTB: settle everything the Clock has already
 * earned the recipient, THEN cancel and withdraw the true remainder to the
 * sender. Sender-signed (the contract asserts ctx.sender() == stream.sender).
 *
 * The composed `claim_accrued` is what keeps the accounting honest. Without it,
 * `cancel_and_withdraw` refunds the WHOLE unclaimed escrow to the sender —
 * including tranches whose due-time had already passed — so a recipient could
 * watch a progress bar fill and then receive none of it. With it, cancelling is
 * atomic: recipient keeps every due tranche, sender gets exactly the rest.
 *
 * `settleAccrued` must be false for an already-PAUSED stream, because
 * `claim_accrued` aborts on `EPaused` and would take the whole cancel down with
 * it. Nothing new can have become claimable while paused, so nothing is lost.
 */
export async function buildStreamCancelSponsored(input: {
  senderAddress: string;
  streamObjectId: string;
  /** Compose `claim_accrued` first. False only when the stream is paused. */
  settleAccrued?: boolean;
  claimableTranches?: number;
}): Promise<{ bytes: string; sponsor: string }> {
  const pkg = streamPackageId();
  if (!pkg) {
    throw new Error("STREAM_PACKAGE_ID unset, on-chain stream cancel disabled");
  }

  return buildSponsored(
    input.senderAddress,
    (tx) => {
      if (input.settleAccrued !== false) {
        tx.moveCall({
          target: `${pkg}::stream::claim_accrued`,
          typeArguments: [USDSUI_TYPE],
          arguments: [tx.object(input.streamObjectId), tx.object(SUI_CLOCK_ID)],
        });
      }
      // cancel_and_withdraw returns the undistributed remainder as
      // Coin<USDSUI>; route it back to the sender in the same PTB.
      const refund = tx.moveCall({
        target: `${pkg}::stream::cancel_and_withdraw`,
        typeArguments: [USDSUI_TYPE],
        arguments: [tx.object(input.streamObjectId)],
      });
      tx.transferObjects([refund], input.senderAddress);
    },
    claimGasBudget(input.claimableTranches ?? 1)
  );
}

// ── Read-side projection helpers (for the list / status routes) ─────────

const MICROS = 1_000_000;

/**
 * How many tranches the on-chain Clock has made DUE by `now`, computed exactly
 * as `stream::claim_accrued` does it: the first tranche is due at `start_ms`,
 * one more every `interval_ms`, capped at `num_tranches`.
 *
 * This is ACCRUED, not released. The difference is real money: an accrued
 * tranche nobody has claimed is still sitting in the Stream object's escrow.
 * Pure schedule arithmetic, no state gating — callers decide what accrual
 * means for a stopped stream.
 */
export function accruedTranches(row: StreamRow, now: number = Date.now()): number {
  const num = Number(row.num_tranches);
  const interval = Number(row.interval_ms);
  if (num <= 0 || interval <= 0) return 0;
  const elapsed = now - Number(row.start_ms);
  if (elapsed < 0) return 0;
  const due = Math.floor(elapsed / interval) + 1; // first tranche fires at start
  return Math.max(0, Math.min(num, due));
}

/**
 * Cumulative µUSDsui that releasing `tranches` tranches pays out. The contract
 * pays `tranche_amount` for the first (num - 1) and the WHOLE remainder on the
 * last, so a full count is always exactly `total_micros` — that is what makes
 * $X/N rounding land on the cent.
 */
function trancheMicrosFor(row: StreamRow, tranches: number): number {
  const num = Number(row.num_tranches);
  const total = Number(row.total_micros);
  const n = Math.max(0, Math.min(num, tranches));
  if (num > 0 && n >= num) return total;
  return Math.min(total, n * Number(row.tranche_micros));
}

/**
 * `completed` is DERIVED, never stored. Nothing writes a `completed` state —
 * there is no scheduler to write it — which is why a finished stream used to
 * sit on `active` forever. A stream is done when the contract's own release
 * cursor says every tranche is out, i.e. nothing is left accruable and nothing
 * is left to claim.
 *
 * `cancelled` outranks it: a cancelled stream stays cancelled even in the edge
 * case where it was fully paid out first.
 */
export function derivedStreamState(row: StreamRow): StreamState {
  if (row.state === "cancelled") return "cancelled";
  const num = Number(row.num_tranches);
  const total = Number(row.total_micros);
  const done = Number(row.tranches_done) || 0;
  const released = Number(row.released_micros) || 0;
  if (num > 0 && done >= num) return "completed";
  if (total > 0 && released >= total) return "completed";
  return row.state;
}

/**
 * Project a stored row into the UI-facing status shape.
 *
 * `releasedUsd` / `tranchesDone` are CONFIRMED figures, mirrored from the
 * contract's own cursors — money that has actually landed in the recipient's
 * wallet. `accruedUsd` / `claimableUsd` are what the Clock has earned but not
 * yet pushed. Keeping them separate is the whole point: the progress bar only
 * ever shows what the chain backs, and the surplus shows up as "ready to
 * claim" instead of being quietly counted as paid.
 *
 * Terminal + paused streams freeze: nothing is claimable on a cancelled,
 * completed or paused stream (the contract aborts a claim while paused), so
 * the frozen figure is the confirmed release cursor and the bar stops where it
 * stopped.
 */
export type ProjectStreamExtras = {
  /**
   * Batch-resolved display names (see `lib/display-name.ts`). Optional: without
   * it the projection degrades to the stored `recipient_handle` snapshot and
   * then to the raw address, exactly as it behaved before names existed.
   */
  names?: DisplayNames;
  /**
   * The viewer's own address, used only to decide WHICH party is the
   * counterparty. On an inbound stream the interesting name is the sender's,
   * not the recipient's (the recipient is the viewer). Omit and the
   * counterparty defaults to the recipient, which is the historical behavior.
   */
  viewerAddress?: string | null;
};

/**
 * Batch-resolve every party name a set of stream rows will need, in one go.
 *
 * Both legs of every row (sender + recipient) go in, so a 20-row list costs ONE
 * database round trip rather than 40. Uses the `full` handle form
 * (`sele@talise.sui`) because that is what the send + stream flows already
 * store and print.
 *
 * The on-chain leg is kept deliberately tight — a list has to feel instant, and
 * a name is worth less than the wait. Whatever the chain does not return inside
 * the budget falls back to the stored snapshot and then the address, and is
 * memoized for the next render either way. Never throws.
 */
export function resolveStreamNames(rows: StreamRow[]): Promise<DisplayNames> {
  const addrs: Array<string | null> = [];
  for (const r of rows) {
    addrs.push(r.recipient_address);
    addrs.push(r.sender_address);
  }
  return resolveDisplayNames(addrs, { form: "full", chainBudget: 4, timeoutMs: 1_200 });
}

export function projectStream(
  row: StreamRow,
  now: number = Date.now(),
  extras: ProjectStreamExtras = {}
) {
  const totalMicros = Number(row.total_micros);
  const numTranches = Number(row.num_tranches);
  const state = derivedStreamState(row);

  const tranchesDone = Math.max(0, Math.min(numTranches, Number(row.tranches_done) || 0));
  const releasedMicros = Math.min(
    totalMicros,
    Math.max(Number(row.released_micros) || 0, trancheMicrosFor(row, tranchesDone))
  );

  // Only a live stream accrues claimably. A paused one keeps ticking on the
  // original schedule but the contract refuses to release, so there is nothing
  // to advertise; a cancelled or completed one is finished.
  const live = state === "active";
  const accrued = live ? Math.max(tranchesDone, accruedTranches(row, now)) : tranchesDone;
  const accruedMicros = live ? trancheMicrosFor(row, accrued) : releasedMicros;
  const claimableTranches = Math.max(0, accrued - tranchesDone);
  const claimableMicros = Math.max(0, accruedMicros - releasedMicros);

  // The Clock time the next UNRELEASED tranche becomes due — the contract's own
  // `due_at = start_ms + tranches_done * interval_ms`. Derived rather than read
  // from the `next_tranche_at` column so the countdown is right even if a
  // mirror write was missed. Null when there is nothing left to wait for.
  const nextTrancheAt =
    live && tranchesDone < numTranches
      ? Number(row.start_ms) + tranchesDone * Number(row.interval_ms)
      : null;

  // ── Party names ─────────────────────────────────────────────────────────
  //
  // `recipient_handle` is a SNAPSHOT taken when the stream was created: a
  // stream started by typing a handle has one, a stream started by pasting an
  // address has NULL, and the row never learns better. That is why one list
  // used to show `sele@talise.sui` on one line and `0xac1d…9df0` on the next
  // for the same person.
  //
  // So: resolve LIVE first (`extras.names`, batched for the whole list), fall
  // back to the stored snapshot, and only then leave it null for the client to
  // truncate. The snapshot is kept as its own field — it is the one record of
  // what the name was at creation time, which a renamed counterparty makes
  // interesting — but it is never what we show when a live name exists.
  const names = extras.names;
  const recipientName = names?.get(row.recipient_address) ?? row.recipient_handle ?? null;
  const senderName = names?.get(row.sender_address) ?? null;

  const viewer = extras.viewerAddress?.trim().toLowerCase() || null;
  const viewerIsRecipient =
    !!viewer && row.recipient_address.toLowerCase() === viewer;
  const counterpartyAddress = viewerIsRecipient
    ? row.sender_address
    : row.recipient_address;
  const counterpartyName = viewerIsRecipient ? senderName : recipientName;

  return {
    id: row.id,
    senderAddress: row.sender_address,
    senderName,
    recipientAddress: row.recipient_address,
    /**
     * Live name when we have one, else the creation-time snapshot. Kept under
     * the original field name so every shipped client build gets the fix
     * without an update.
     */
    recipientHandle: recipientName,
    /** The snapshot exactly as stored, for anyone who wants creation-time truth. */
    recipientHandleAtCreation: row.recipient_handle,
    /**
     * THE OTHER PARTY, from the viewer's side: the sender on an inbound
     * stream, the recipient on an outbound one. An inbound row labelled with
     * the recipient's name was labelling the viewer with their own name.
     */
    counterpartyAddress,
    counterpartyName,
    totalUsd: totalMicros / MICROS,
    /** Confirmed on-chain: in the recipient's wallet. */
    releasedUsd: releasedMicros / MICROS,
    remainingUsd: Math.max(0, (totalMicros - releasedMicros) / MICROS),
    /** Earned by the Clock, claimed or not. */
    accruedUsd: accruedMicros / MICROS,
    accruedTranches: accrued,
    /** Earned but not yet pushed — what the next claim moves. */
    claimableUsd: claimableMicros / MICROS,
    claimableTranches,
    /** The auto-fire gate: something is due that the chain hasn't paid yet. */
    dueNow: live && claimableTranches > 0,
    trancheUsd: Number(row.tranche_micros) / MICROS,
    numTranches,
    tranchesDone,
    startMs: Number(row.start_ms),
    intervalMs: Number(row.interval_ms),
    nextTrancheAt,
    /** Derived — `completed` is never stored. */
    state,
    fundingDigest: row.funding_digest,
    lastTrancheDigest: row.last_tranche_digest,
    lastTrancheAt: row.last_tranche_at,
    createdAt: row.created_at,
  };
}

/** Base64 of unsigned PTB bytes (for create-prepare to return to iOS). */
export function bytesToB64(bytes: Uint8Array): string {
  return toBase64(bytes);
}
