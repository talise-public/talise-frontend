/**
 * Resumable batch indexer — the engine that walks Talise users on-chain a chunk
 * at a time.
 *
 * Indexing ~2,000 users' full on-chain tx history is far too much for one HTTP
 * request, so it runs CHUNKED + PERSISTED + RESUMABLE: a singleton cursor (offset
 * into the id-ordered user list) advances one batch per invocation, driven by a
 * cron + a manual "Index now" button. Each batch:
 *   1. ensures the schema + reads the live total + current cursor,
 *   2. pages `batchSize` users starting at the cursor,
 *   3. indexes them through a concurrency-limited pool (indexUser per address),
 *   4. upserts each user's aggregate + their txs into the recent-tx feed,
 *   5. advances the cursor by however many users were paged; when the cursor
 *      reaches/passes the total it WRAPS to 0 and stamps `full_pass_at`
 *      (done:true — a full pass over every user just completed),
 *   6. trims the recent-tx feed to its bound.
 *
 * Resilient per user: one user's indexing/persistence failure is swallowed so the
 * batch (and the cursor advance) always completes. One Date.now() stamp is used
 * for the whole batch so every write in a pass shares a consistent timestamp.
 */

import { countUsers, listUsersPage } from "@/lib/analytics/users";
import type { PagedUser } from "@/lib/analytics/users";
import { indexUser } from "@/lib/analytics/index-user";
import {
  ensureAnalyticsSchema,
  getCursor,
  recordRecentTxs,
  setCursor,
  trimRecentTxs,
  upsertUserStat,
} from "@/lib/analytics/store";
import type { RecentTx } from "@/lib/analytics/types";

/** Outcome of one batch pass — drives the cron loop + dashboard progress. */
export type BatchResult = {
  processed: number; // users paged + attempted this batch
  cursor: number; // cursor AFTER this batch (next offset; 0 if it wrapped)
  total: number; // live total indexable users at batch start
  done: boolean; // true iff this batch completed a full pass (cursor wrapped)
  indexedAt: number; // the single Date.now() stamp for this batch
};

/** Defaults per the build contract. */
const DEFAULT_BATCH_SIZE = 40;
const DEFAULT_CONCURRENCY = 5;

/** Bound on the persisted recent-tx feed (newest N kept). */
const RECENT_TX_KEEP = 2000;

/**
 * Run a concurrency-limited pool over `items`, invoking `worker` for each. Caps
 * in-flight work at `concurrency`; resolves once every item has been processed.
 * The worker is expected to be self-contained and never reject (callers wrap
 * per-item failures), but a rejection here would still surface — so callers pass
 * a worker that swallows its own errors.
 */
async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency));
  let next = 0;

  async function lane(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  }

  const lanes: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    lanes.push(lane());
  }
  await Promise.all(lanes);
}

/**
 * Index one user and persist their aggregate + recent txs. Fully self-contained
 * and resilient: any failure (source read, aggregate, or write) is swallowed so
 * the pool — and the batch's cursor advance — is never derailed by a single user.
 */
async function indexAndPersist(
  user: PagedUser,
  indexedAt: number
): Promise<void> {
  try {
    const idx = await indexUser(user.address);

    await upsertUserStat({
      userId: user.userId,
      address: user.address,
      handle: user.handle,
      idx,
      indexedAt,
    });

    // Build recent-tx rows from this user's txs, attaching their handle/address
    // so the feed can render "who" alongside the on-chain counterparty.
    const rows: RecentTx[] = idx.txs.map((tx) => ({
      digest: tx.digest,
      ts: tx.ts,
      direction: tx.direction,
      amountUsd: tx.amountUsd,
      handle: user.handle,
      address: user.address,
      counterparty: tx.counterparty,
      counterpartyName: tx.counterpartyName,
    }));

    if (rows.length > 0) {
      await recordRecentTxs(rows, indexedAt);
    }
  } catch {
    // Resilient per user: skip this one, keep the batch going.
  }
}

/**
 * Advance the analytics index by one batch and return the new state.
 *
 * Reads the live total + current cursor, pages the next `batchSize` users from
 * the cursor offset, indexes them concurrently, and persists. The cursor then
 * advances by the number of users paged; when it reaches/exceeds the total it
 * wraps to 0 and stamps a fresh `full_pass_at` (done:true). An empty page (cursor
 * already at/past the end, or no users at all) is also treated as a completed
 * pass and wraps to 0. The recent-tx feed is trimmed at the end. Every write in
 * the batch shares one `indexedAt` stamp.
 */
export async function runIndexBatch(opts?: {
  batchSize?: number;
  concurrency?: number;
}): Promise<BatchResult> {
  const indexedAt = Date.now();

  const batchSize = Math.max(
    1,
    Math.floor(opts?.batchSize ?? DEFAULT_BATCH_SIZE)
  );
  const concurrency = Math.max(
    1,
    Math.floor(opts?.concurrency ?? DEFAULT_CONCURRENCY)
  );

  await ensureAnalyticsSchema();

  const total = await countUsers();
  const state = await getCursor();
  // Clamp a corrupted/stale cursor into the current [0, total] window.
  const startCursor =
    Number.isFinite(state.cursor) && state.cursor > 0
      ? Math.min(Math.floor(state.cursor), total)
      : 0;

  // Nothing to index (no users at all) — record an empty completed pass.
  if (total <= 0) {
    await setCursor({
      cursor: 0,
      total,
      lastRunAt: indexedAt,
      fullPassAt: indexedAt,
    });
    await trimRecentTxs(RECENT_TX_KEEP);
    return { processed: 0, cursor: 0, total, done: true, indexedAt };
  }

  const users = await listUsersPage(startCursor, batchSize);
  const processed = users.length;

  // Index this page concurrently. Each worker swallows its own errors.
  if (processed > 0) {
    await runPool(users, concurrency, (u) => indexAndPersist(u, indexedAt));
  }

  // Advance the cursor. A full page that lands us at/past total — or an empty
  // page (we were already at the end) — completes a pass and wraps to 0.
  const advanced = startCursor + processed;
  const done = advanced >= total || processed === 0;
  const nextCursor = done ? 0 : advanced;

  await setCursor({
    cursor: nextCursor,
    total,
    lastRunAt: indexedAt,
    // Only stamp full_pass_at when a pass actually completed.
    fullPassAt: done ? indexedAt : undefined,
  });

  await trimRecentTxs(RECENT_TX_KEEP);

  return { processed, cursor: nextCursor, total, done, indexedAt };
}
