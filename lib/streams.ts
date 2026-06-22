import "server-only";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { db, ensureSchema, schemaVersionGate } from "@/lib/db";
import { sui } from "@/lib/sui";
import { USDSUI_TYPE } from "@/lib/usdsui";
import { onara } from "@/lib/onara";
import { getNormalizedTransaction } from "@/lib/sui-shapes";

/**
 * Streaming USDsui payments — backend data layer + escrow release engine.
 *
 * This is the ESCROW + SCHEDULER variant of the design
 * (docs/features/streaming-payments.md §2 option (c), made runnable today
 * WITHOUT a published `talise::stream` Move module):
 *
 *   • The sender funds the FULL stream amount ONCE into a Talise-controlled
 *     ESCROW address via the existing transfer pipeline (a plain USDsui
 *     `0x2::balance::send_funds` send — the same builder /api/send/
 *     sponsor-prepare uses). That escrow address is derived from the server
 *     ESCROW keypair (`STREAM_ESCROW_SK`), mirroring the operator-keypair
 *     pattern in web/lib/suins-operator.ts.
 *   • A Vercel cron (`/api/cron/process-streams`) releases each due tranche
 *     by having THIS backend sign an escrow→recipient USDsui transfer with
 *     the server ESCROW keypair. The release is a gasless
 *     `0x2::balance::send_funds<USDSUI>` from the escrow's Address Balance
 *     accumulator when the accumulator is funded (it is, because the sender
 *     just funded it via the same accumulator rail).
 *
 * Degrade-clean: if `STREAM_ESCROW_SK` is unset, `streamEscrowEnabled()` is
 * false, escrow funding is rejected at create time, and the cron no-ops.
 *
 * Future-hardened path: a published `talise::stream` Move module (gated
 * behind `STREAM_PACKAGE_ID`). `streamPackageId()` returns it when set;
 * nothing here depends on it being set, so an unset id never breaks
 * build/runtime. See `move/talise/sources/stream.move` for the source.
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
 * scheduler variant does NOT need it — it is the seam for the future
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
 * True when the on-chain `talise::stream` path is configured — just the
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
      "STREAM_ESCROW_SK missing — the Talise-controlled escrow keypair that holds streamed funds"
    );
  }
  _escrow = Ed25519Keypair.fromSecretKey(k);
  return _escrow;
}

/** The escrow's Sui address — the funding destination for every stream. */
export function streamEscrowAddress(): string {
  return escrowKeypair().getPublicKey().toSuiAddress();
}

// ── Schema (self-bootstrapping, memoized once-per-process) ──────────────
// Mirrors web/lib/send-limits.ts ensureLedgerSchema discipline: a
// once-per-process promise that resets on failure so a transient error
// retries. Postgres DDL (SERIAL / BIGINT / TEXT / partial + unique index /
// ON CONFLICT). Schema per the design (§5).
let _schemaReadyP: Promise<void> | null = null;

// Bump whenever ANY DDL below changes — the one-SELECT version gate skips the
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
    // row is the scheduler index + UI cache. `id` is the stream id — the
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

// ════════════════════════════════════════════════════════════════════════
// ON-CHAIN `talise::stream` PATH (gated behind STREAM_PACKAGE_ID).
//
// When the package + registry ids + worker key are all set
// (streamOnchainEnabled()), Talise creates a REAL shared `Stream<USDSUI>`
// object instead of routing funds through the server escrow address. The
// builders below mirror the contract ABI:
//
//   create<T>(registry, funds: Balance<T>, recipient, tranche_amount,
//             num_tranches, start_ms, interval_ms, clock, ctx): ID
//   release<T>(registry, stream, clock, ctx)                 // worker-signed
//   cancel_and_withdraw<T>(stream, ctx): Coin<T>             // sender-signed
//
// FUNDING PATTERN (the crux):
//   • create is a SPONSORED tx — a custom Move call is NOT gasless-eligible
//     (only 0x2::balance::send_funds is). So Onara sponsors gas, the user
//     signs. Mirrors the SPONSORED branch of /api/send/sponsor-prepare:
//     onara().status() for the sponsor address + reference gas price,
//     setSender(user), setGasOwner(sponsor), setGasPrice, build → sponsor-
//     ready bytes the iOS client signs and POSTs to /api/zk/sponsor-execute.
//   • The Balance<USDSUI> `funds` argument comes from the user's Address
//     Balance accumulator via tx.balance({ type, balance }) — the SAME
//     accumulator-withdrawal primitive the gasless branch passes to
//     0x2::balance::send_funds — handed straight as the create() arg.
//   • release is a WORKER-signed Move call that pays its OWN SUI gas (the
//     worker = the STREAM_ESCROW_SK key, funded for gas). Build → worker
//     signTransaction → executeTransaction, mirroring suins-operator.ts.
//   • cancel_and_withdraw is SPONSORED (sender-signed), same shape as create.
// ════════════════════════════════════════════════════════════════════════

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
      "STREAM_PACKAGE_ID / STREAM_REGISTRY_ID unset — on-chain stream create disabled"
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
  //   • Coin<USDSUI> objects (the common case — received funds, on-ramp, swaps)
  //     → coinWithBalance({useGasCoin:false}) auto-merges/splits owned coins,
  //       then coin::into_balance converts Coin → Balance. Same primitive every
  //       other Talise contract-funding flow uses (goal vault, sponsored send).
  //   • Address-Balance accumulator → tx.balance (the gasless-send rail).
  // Using ONLY the accumulator (the old behaviour) aborted on execution for any
  // user whose funds were in coins — which is most of them — hence "couldn't
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
    // listCoins read failed — fall through to the accumulator path.
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
  // Explicit budget (0.06 SUI) — without it the built bytes carry no gas
  // budget and execution fails with InsufficientGas. Same fixed budget the
  // goal-vault + send sponsored builders use; only the gas actually consumed
  // is charged to the sponsor.
  tx.setGasBudget(60_000_000n);

  const bytes = await tx.build({ client: client as never });
  return { bytes: toBase64(bytes), sponsor };
}

/**
 * Build the Onara-SPONSORED `talise::stream::claim_accrued<USDSUI>` PTB.
 *
 * THIS is the cron-less release path. `claim_accrued` is permissionless on
 * chain: it walks the schedule, releases EVERY tranche whose Clock due-time has
 * passed, and transfers it to the stream's hardwired `recipient` — so there is
 * no extraction surface (a caller can only push DUE funds to the recipient,
 * never to themselves, never more than the schedule allows). The recipient
 * signs (zkLogin) and Onara sponsors the gas, so claiming is free and needs no
 * worker key and no scheduler. Returns sponsor-ready bytes the client signs and
 * POSTs to /api/zk/sponsor-execute.
 *
 * Requires streamOnchainEnabled() upstream (caller gates).
 */
export async function buildClaimAccruedSponsored(input: {
  /** The on-chain `Stream<USDSUI>` object id (== the stream's DB id). */
  streamObjectId: string;
  /** The signer (the recipient, in practice). Funds always go to the
   *  contract-hardwired recipient regardless of who signs. */
  signerAddress: string;
}): Promise<{ bytes: string; sponsor: string }> {
  const pkg = streamPackageId();
  if (!pkg) {
    throw new Error("STREAM_PACKAGE_ID unset — on-chain stream claim disabled");
  }

  const onaraClient = onara();
  const client = sui();

  const [{ address: sponsor }, gasPrice] = await Promise.all([
    onaraClient.status(),
    client.getReferenceGasPrice().then((r) => r.referenceGasPrice),
  ]);

  const tx = new Transaction();
  tx.setSender(input.signerAddress);
  tx.moveCall({
    target: `${pkg}::stream::claim_accrued`,
    typeArguments: [USDSUI_TYPE],
    arguments: [tx.object(input.streamObjectId), tx.object(SUI_CLOCK_ID)],
  });
  // SPONSORED: Onara owns the gas; the recipient signs the sender slot.
  tx.setGasOwner(sponsor);
  tx.setGasPrice(BigInt(gasPrice));

  const bytes = await tx.build({ client: client as never });
  return { bytes: toBase64(bytes), sponsor };
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
 * fullnode reads often lag indexing by 1–3s — so a single read here used to
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
      // Most likely "not found" — the node hasn't indexed the digest yet.
      console.warn(
        `[streams] parseCreatedStreamObjectId getTransaction failed (attempt ${attempt + 1}/${DELAYS_MS.length}) digest=${digest}: ${(err as Error).message}`
      );
      continue;
    }
    // A readable failed tx will never produce the object — stop retrying.
    if (tx.status !== "success") return null;

    for (const oc of tx.objectChanges) {
      if (oc.kind !== "created") continue;
      const ty = (oc.objectType ?? "").toLowerCase();
      if (ty.startsWith(prefix)) {
        return oc.objectId;
      }
    }
    // Readable + successful but no Stream object — retrying won't change it.
    return null;
  }
  return null;
}

/**
 * Build the Onara-SPONSORED `talise::stream::cancel_and_withdraw<USDSUI>` PTB.
 * Sender-signed (the contract asserts ctx.sender() == stream.sender), Onara-
 * sponsored for gas (a custom Move call is not gasless-eligible). The returned
 * `Coin<USDSUI>` remainder is transferred back to the sender in the same PTB.
 *
 * Returns sponsor-ready base64 bytes that iOS signs and POSTs to
 * /api/zk/sponsor-execute. Throws on build failure (the caller categorizes).
 */
export async function buildStreamCancelSponsored(input: {
  senderAddress: string;
  streamObjectId: string;
}): Promise<{ bytes: string; sponsor: string }> {
  const pkg = streamPackageId();
  if (!pkg) {
    throw new Error("STREAM_PACKAGE_ID unset — on-chain stream cancel disabled");
  }

  const onaraClient = onara();
  const client = sui();

  const [{ address: sponsor }, gasPrice] = await Promise.all([
    onaraClient.status(),
    client.getReferenceGasPrice().then((r) => r.referenceGasPrice),
  ]);

  const tx = new Transaction();
  tx.setSender(input.senderAddress);

  // cancel_and_withdraw returns the undistributed remainder as Coin<USDSUI>;
  // route it back to the sender in the same PTB.
  const refund = tx.moveCall({
    target: `${pkg}::stream::cancel_and_withdraw`,
    typeArguments: [USDSUI_TYPE],
    arguments: [tx.object(input.streamObjectId)],
  });
  tx.transferObjects([refund], input.senderAddress);

  tx.setGasOwner(sponsor);
  tx.setGasPrice(BigInt(gasPrice));

  const bytes = await tx.build({ client: client as never });
  return { bytes: toBase64(bytes), sponsor };
}

// ── Read-side projection helpers (for the list / status routes) ─────────

const MICROS = 1_000_000;

/**
 * How many tranches the on-chain Clock has released by `now`, derived the same
 * way the `stream::claim_accrued` contract does: the first tranche is due at
 * `start_ms` and one more every `interval_ms`, capped at `num_tranches`. We
 * compute this instead of trusting `released_micros` because the stream is
 * CRON-LESS — nothing writes `released_micros` back, so it would sit at 0
 * forever and the bar would never move. The full amount is locked on-chain at
 * create, so accrued tranches are guaranteed to the recipient (a claim just
 * realizes them). Frozen for terminal states (cancelled/completed) so a stopped
 * stream doesn't keep "accruing".
 */
function accruedTranches(row: StreamRow, now: number): number {
  const num = Number(row.num_tranches);
  const interval = Number(row.interval_ms);
  if (num <= 0 || interval <= 0) return Number(row.tranches_done) || 0;
  const elapsed = now - Number(row.start_ms);
  if (elapsed < 0) return 0;
  const due = Math.floor(elapsed / interval) + 1; // first tranche fires at start
  return Math.max(0, Math.min(num, due));
}

/** Project a stored row into the UI-facing status shape with USD figures. */
export function projectStream(row: StreamRow) {
  const total = Number(row.total_micros) / MICROS;
  const trancheMicros = Number(row.tranche_micros);
  const numTranches = Number(row.num_tranches);

  // Active streams: progress comes from the Clock (accrued). Terminal/paused
  // states keep their stored value (a cancelled stream stops accruing; a
  // completed one is already full).
  let tranchesDone: number;
  let releasedMicros: number;
  if (row.state === "active") {
    tranchesDone = accruedTranches(row, Date.now());
    releasedMicros = Math.min(Number(row.total_micros), tranchesDone * trancheMicros);
  } else {
    tranchesDone = Number(row.tranches_done) || 0;
    releasedMicros = Number(row.released_micros) || 0;
  }
  const released = releasedMicros / MICROS;
  return {
    id: row.id,
    senderAddress: row.sender_address,
    recipientAddress: row.recipient_address,
    recipientHandle: row.recipient_handle,
    totalUsd: total,
    releasedUsd: released,
    remainingUsd: Math.max(0, total - released),
    trancheUsd: trancheMicros / MICROS,
    numTranches: numTranches,
    tranchesDone,
    startMs: Number(row.start_ms),
    intervalMs: Number(row.interval_ms),
    nextTrancheAt: Number(row.next_tranche_at),
    state: row.state,
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
