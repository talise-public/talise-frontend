import "server-only";

import { db } from "@/lib/db";
import {
  SHIELD,
  SHIELD_RPC,
  shieldConfigured,
  shieldEventType,
} from "@/lib/shield/onchain";
import {
  ensureShieldSchema,
  getShieldCursor,
  maxLeafIndex,
  type ShieldPipeline,
} from "@/lib/shield/db";
import { refreshMerkleCache } from "@/lib/shield/merkle";
import { USDSUI_TYPE } from "@/lib/usdsui";

/**
 * Talise shielded-pool, event indexer (Workstream C).
 *
 * A `suix_queryEvents` CURSOR POLLER (NOT a Rust checkpoint streamer),
 * designed to run from a Vercel cron. It mirrors the JSON-RPC fetch pattern of
 * `app/api/yield/position/route.ts`, a direct `fetch` to the fullnode, no new
 * SDK surface.
 *
 * Three independent pipelines, each with its own Postgres cursor:
 *   commitments  → NewCommitment<CoinType>  → shield_commitments (Merkle leaves)
 *   nullifiers   → NullifierSpent<CoinType>  → shield_nullifiers (spent notes)
 *   pools        → NewPool<CoinType>         → shield_pools (per-coin registry)
 *
 * Guarantees:
 *   • Idempotent, every write uses ON CONFLICT keyed on the natural id, and
 *     the cursor advance happens in the SAME db().batch() transaction as the
 *     writes, so a crash mid-page never skips or double-counts events.
 *   • Consistency check, after the commitments pipeline catches up, asserts
 *     the on-chain `next_index` equals `MAX(leaf_index)+1` in Postgres.
 *
 * Dormant unless `shieldConfigured()`.
 */

const PAGE_SIZE = 50;
const RPC_TIMEOUT_MS = 12_000;

type SuiEventId = { txDigest: string; eventSeq: string };

interface RawSuiEvent {
  id: SuiEventId;
  type: string;
  parsedJson?: unknown;
  sender?: string;
  timestampMs?: string;
}

interface QueryEventsResult {
  data: RawSuiEvent[];
  nextCursor: SuiEventId | null;
  hasNextPage: boolean;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(SHIELD_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`RPC ${method} failed: ${body.error.message ?? "unknown"}`);
  return body.result as T;
}

/**
 * One page of `suix_queryEvents` filtered to the shield events MODULE, ascending.
 *
 * CRITICAL: the pool's events are GENERIC, `events::NewCommitment<CoinType>` etc.
 * A `MoveEventType` filter on the bare `…::events::NewCommitment` matches NOTHING
 * (Sui requires the exact instantiated type), so the indexer was silently
 * ingesting ZERO commitments while 20 sat on-chain → every withdraw's merkle-path
 * lookup failed → withdraw never submitted → recipient never paid. Filtering by
 * MODULE returns all generic instantiations; the caller then matches the struct,
 * which is robust to CoinType formatting (no fragile generic string-matching).
 */
async function queryEventsPage(cursor: SuiEventId | null): Promise<QueryEventsResult> {
  return rpc<QueryEventsResult>("suix_queryEvents", [
    { MoveEventModule: { package: SHIELD.packageId, module: SHIELD.module } },
    cursor,
    PAGE_SIZE,
    false, // ascending, we index oldest→newest so leaf order is monotonic
  ]);
}

/**
 * Fetch the on-chain pool's `next_index` from the MerkleTree, if readable.
 *
 * The `MerkleTree` is NOT an inline field of the pool, `shielded_pool.move`
 * stores it as a DYNAMIC OBJECT FIELD keyed by the empty struct
 * `MerkleTreeKey()` (see `MerkleTreeKey` + the `dof` idiom in the Move source).
 * So we resolve that dynamic field on the pool object and read `next_index`
 * from the MerkleTree's own content fields. Best-effort: any read failure
 * returns null and the consistency check is simply skipped (report-only, it
 * never throws and never blocks ingestion).
 */
async function onchainNextIndex(): Promise<number | null> {
  if (!SHIELD.poolUsdsui || !SHIELD.packageId) return null;
  try {
    const obj = await rpc<{
      data?: { content?: { fields?: Record<string, unknown> } };
    }>("suix_getDynamicFieldObject", [
      SHIELD.poolUsdsui,
      {
        // `MerkleTreeKey()` is an empty positional struct, on the wire it is
        // represented as `{ dummy_field: bool }` (Sui's synthetic field for
        // fieldless structs). Verified live on the mainnet fullnode: with this
        // key the dynamic OBJECT field resolves to the MerkleTree object whose
        // top-level content fields are [id, next_index, root_history,
        // root_index, subtrees].
        type: `${SHIELD.packageId}::shielded_pool::MerkleTreeKey`,
        value: { dummy_field: false },
      },
    ]);
    const fields = obj.data?.content?.fields as Record<string, unknown> | undefined;
    if (!fields) return null;
    // For a dynamic OBJECT field the resolved object IS the MerkleTree, so
    // `next_index` sits directly on `content.fields`. (A dynamic VALUE field
    // would instead wrap the value under `.value.fields`.) Probe both shapes.
    const inner =
      (fields.value as { fields?: Record<string, unknown> } | undefined)?.fields ??
      fields;
    const raw = (inner as Record<string, unknown>)?.next_index;
    if (raw === undefined || raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ── Per-pipeline ingest ──────────────────────────────────────────────────

function nowCursorRow(pipeline: ShieldPipeline, cur: SuiEventId | null) {
  return {
    sql: `INSERT INTO shield_index_cursor (pipeline, tx_digest, event_seq, checkpoint, updated_at)
          VALUES (?, ?, ?, NULL, ?)
          ON CONFLICT (pipeline) DO UPDATE SET
            tx_digest = EXCLUDED.tx_digest,
            event_seq = EXCLUDED.event_seq,
            updated_at = EXCLUDED.updated_at`,
    args: [pipeline, cur?.txDigest ?? null, cur?.eventSeq ?? null, Date.now()],
  };
}

/**
 * Drain one pipeline to its tip, batching writes + cursor advance per page.
 * Returns the number of events ingested.
 */
async function drainPipeline(
  pipeline: ShieldPipeline,
  buildStmts: (e: RawSuiEvent) => { sql: string; args: unknown[] }[]
): Promise<number> {
  const stored = await getShieldCursor(pipeline);
  let cursor: SuiEventId | null = stored
    ? { txDigest: stored.txDigest, eventSeq: stored.eventSeq }
    : null;

  const eventType = shieldEventType(
    pipeline === "commitments"
      ? "NewCommitment"
      : pipeline === "nullifiers"
        ? "NullifierSpent"
        : "NewPool"
  );

  let total = 0;
  // Bound the run so a cron invocation can't loop forever on a huge backlog;
  // the next invocation resumes from the persisted cursor.
  for (let page = 0; page < 200; page++) {
    const res = await queryEventsPage(cursor);
    if (res.data.length === 0) break;

    const stmts: { sql: string; args: unknown[] }[] = [];
    let matched = 0;
    for (const ev of res.data) {
      // The module filter returns ALL generic event types; ingest only THIS
      // pipeline's struct (compare ignoring the `<CoinType>` generic).
      if (ev.type.split("<")[0] !== eventType) continue;
      stmts.push(...buildStmts(ev));
      matched++;
    }

    // Advance the cursor in the SAME transaction as the writes (over ALL module
    // events, each pipeline keeps its own cursor + filters its own struct).
    const nextCursor = res.nextCursor ?? res.data[res.data.length - 1].id;
    stmts.push(nowCursorRow(pipeline, nextCursor));

    await db().batch(stmts, "write");
    total += matched;
    cursor = nextCursor;

    if (!res.hasNextPage) break;
  }
  return total;
}

// Note: the per-coin filter relies on the package id appearing in the event's
// generic CoinType param. We index every CoinType the pool emits and key rows
// by the parsed type; the USDsui pool is the only live one today.
function coinTypeOf(ev: RawSuiEvent): string {
  // type looks like `${pkg}::events::NewCommitment<0x..::usdsui::USDSUI>`.
  const m = ev.type.match(/<(.+)>$/);
  return m ? m[1] : USDSUI_TYPE;
}

/** Ingest NewCommitment events into shield_commitments. */
async function ingestCommitments(): Promise<number> {
  return drainPipeline("commitments", (ev) => {
    const pj = (ev.parsedJson ?? {}) as {
      index?: string | number;
      commitment?: string;
      encrypted_output?: number[] | string;
    };
    const coinType = coinTypeOf(ev);
    const leafIndex = Number(pj.index);
    const commitment = String(pj.commitment ?? "0");
    // encrypted_output is a vector<u8>. JSON-RPC renders it as EITHER a number[]
    // OR (on many fullnode versions) a base64 STRING. Normalize BOTH to 0x-hex
    // so the scanner can always decode it, storing the base64 string verbatim
    // (the old behavior) made trial-decrypt parse it as hex → fail → scan found
    // NOTHING → notes stranded. A `0x`-hex string is passed through unchanged.
    let enc: string | null = null;
    const raw = pj.encrypted_output;
    if (Array.isArray(raw)) {
      enc = "0x" + Buffer.from(raw).toString("hex");
    } else if (typeof raw === "string") {
      if (/^0x[0-9a-fA-F]*$/.test(raw)) {
        enc = raw.toLowerCase();
      } else {
        // base64 → 0x-hex (the common JSON-RPC case that broke scanning).
        enc = "0x" + Buffer.from(raw, "base64").toString("hex");
      }
    }
    return [
      {
        sql: `INSERT INTO shield_commitments
                (coin_type, leaf_index, commitment, encrypted_output, digest, sender, checkpoint, event_seq, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (coin_type, leaf_index) DO NOTHING`,
        args: [
          coinType,
          leafIndex,
          commitment,
          enc,
          ev.id.txDigest,
          ev.sender ?? null,
          null,
          ev.id.eventSeq,
          ev.timestampMs ? Number(ev.timestampMs) : Date.now(),
        ],
      },
    ];
  });
}

/** Ingest NullifierSpent events into shield_nullifiers. */
async function ingestNullifiers(): Promise<number> {
  return drainPipeline("nullifiers", (ev) => {
    // The event is `NullifierSpent { nullifier: u256 }`; JSON-RPC surfaces it as
    // `{ "nullifier": "<u256>" }`. The pos0/"0"/first-value fallbacks keep the
    // older positional-struct shape readable too.
    const pj = ev.parsedJson as unknown;
    let nullifier = "0";
    if (pj && typeof pj === "object") {
      const o = pj as Record<string, unknown>;
      nullifier = String(o.nullifier ?? o.pos0 ?? o["0"] ?? Object.values(o)[0] ?? "0");
    } else if (pj !== undefined && pj !== null) {
      nullifier = String(pj);
    }
    const coinType = coinTypeOf(ev);
    return [
      {
        sql: `INSERT INTO shield_nullifiers
                (coin_type, nullifier, digest, checkpoint, event_seq, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (coin_type, nullifier) DO NOTHING`,
        args: [
          coinType,
          nullifier,
          ev.id.txDigest,
          null,
          ev.id.eventSeq,
          ev.timestampMs ? Number(ev.timestampMs) : Date.now(),
        ],
      },
    ];
  });
}

/** Ingest NewPool events into shield_pools. */
async function ingestPools(): Promise<number> {
  return drainPipeline("pools", (ev) => {
    // `NewPool { pool: address }` → `{ "pool": "0x.." }`; fallbacks cover the
    // older positional shape.
    const pj = ev.parsedJson as unknown;
    let poolAddr = "";
    if (pj && typeof pj === "object") {
      const o = pj as Record<string, unknown>;
      poolAddr = String(o.pool ?? o.pos0 ?? o["0"] ?? Object.values(o)[0] ?? "");
    } else if (pj !== undefined && pj !== null) {
      poolAddr = String(pj);
    }
    const coinType = coinTypeOf(ev);
    return [
      {
        sql: `INSERT INTO shield_pools (coin_type, pool_address, digest, checkpoint, created_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT (coin_type) DO UPDATE SET
                pool_address = EXCLUDED.pool_address,
                digest = EXCLUDED.digest`,
        args: [coinType, poolAddr, ev.id.txDigest, null, Date.now()],
      },
    ];
  });
}

export interface IndexerRunResult {
  ran: boolean;
  commitments: number;
  nullifiers: number;
  pools: number;
  consistency: {
    coinType: string;
    onchainNextIndex: number | null;
    dbMaxLeafPlusOne: number;
    ok: boolean | null;
  } | null;
}

/**
 * Run all three pipelines to their tip + the on-chain consistency check.
 * No-ops (ran:false) when the feature is dormant. Safe to call repeatedly
 * (idempotent); intended entrypoint for the Vercel cron.
 */
export async function runShieldIndexer(): Promise<IndexerRunResult> {
  if (!shieldConfigured()) {
    return { ran: false, commitments: 0, nullifiers: 0, pools: 0, consistency: null };
  }
  await ensureShieldSchema();

  const pools = await ingestPools();
  const commitments = await ingestCommitments();
  const nullifiers = await ingestNullifiers();

  // Refresh the cached frontier so the path service serves a fresh root.
  const coinType = USDSUI_TYPE;
  if (commitments > 0) {
    await refreshMerkleCache(coinType).catch(() => {});
  }

  // Consistency check: on-chain next_index == MAX(leaf_index)+1 in Postgres.
  const onchain = await onchainNextIndex();
  const dbMax = await maxLeafIndex(coinType);
  const dbNext = dbMax + 1;
  const consistency = {
    coinType,
    onchainNextIndex: onchain,
    dbMaxLeafPlusOne: dbNext,
    ok: onchain === null ? null : onchain === dbNext,
  };

  return { ran: true, commitments, nullifiers, pools, consistency };
}
