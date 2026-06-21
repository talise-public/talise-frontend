import "server-only";

import { after } from "next/server";
import { db, ensureSchema } from "@/lib/db";

/**
 * Durable, cross-instance fast-load caches for the hot Home endpoints.
 *
 * These let /api/balances and /api/activity serve a last-known value in one
 * indexed PK read (~10-50ms) instead of a live Sui chain read (USDsui
 * ~600-1800ms, activity scan ~1-3s). Unlike perf-cache.ts memoTtl (an
 * in-process Map, lost on every cold serverless instance), these survive
 * cold starts and are shared across the fleet.
 *
 * HARD INVARIANT: DISPLAY-ONLY. A snapshot may feed pixels, never the bytes
 * of a transaction or any limit/eligibility check. Sends/withdraws/sweeps
 * stay on the live chain + the authoritative send_limit ledger.
 */

// ─── Background refresh ──────────────────────────────────────────────────

/**
 * Run `fn` AFTER the response is flushed (Next.js `after()`), so a cache
 * hit can return instantly while the live chain read + write-through warm
 * the snapshot for the next load. Falls back to a detached run if `after()`
 * isn't available in the current context (e.g. tests). Never throws.
 */
export function refreshInBackground(fn: () => Promise<void>): void {
  const guarded = () =>
    fn().catch((e) =>
      console.warn(`[snapshots] background refresh failed: ${(e as Error)?.message ?? e}`)
    );
  try {
    after(guarded);
  } catch {
    void guarded();
  }
}

// ─── Balance snapshot ────────────────────────────────────────────────────

export type BalanceSnapshot = {
  userId: number;
  suiAddress: string;
  usdsui: number;
  sui: number;
  suiPriceUsd: number;
  totalUsd: number;
  source: string;
  /** Epoch ms of the last live chain refresh behind this row. */
  refreshedAt: number;
};

export async function readBalanceSnapshot(userId: number): Promise<BalanceSnapshot | null> {
  try {
    await ensureSchema();
    const r = await db().execute({
      sql: `SELECT user_id, sui_address, usdsui, sui, sui_price_usd, total_usd, source, refreshed_at
              FROM user_balance_snapshot WHERE user_id = $1 LIMIT 1`,
      args: [userId],
    });
    const row = r.rows[0];
    if (!row) return null;
    return {
      userId: Number(row.user_id),
      suiAddress: String(row.sui_address ?? ""),
      usdsui: Number(row.usdsui) || 0,
      sui: Number(row.sui) || 0,
      suiPriceUsd: Number(row.sui_price_usd) || 0,
      totalUsd: Number(row.total_usd) || 0,
      source: String(row.source ?? "chain"),
      refreshedAt: Number(row.refreshed_at) || 0,
    };
  } catch {
    return null;
  }
}

export async function writeBalanceSnapshot(s: {
  userId: number;
  suiAddress: string;
  usdsui: number;
  sui: number;
  suiPriceUsd: number;
  totalUsd: number;
  source?: string;
}): Promise<void> {
  try {
    await ensureSchema();
    const t = Date.now();
    await db().execute({
      sql: `INSERT INTO user_balance_snapshot
              (user_id, sui_address, usdsui, sui, sui_price_usd, total_usd, source, refreshed_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
            ON CONFLICT (user_id) DO UPDATE SET
              sui_address = EXCLUDED.sui_address,
              usdsui = EXCLUDED.usdsui,
              sui = EXCLUDED.sui,
              sui_price_usd = EXCLUDED.sui_price_usd,
              total_usd = EXCLUDED.total_usd,
              source = EXCLUDED.source,
              refreshed_at = EXCLUDED.refreshed_at,
              updated_at = EXCLUDED.updated_at`,
      args: [s.userId, s.suiAddress, s.usdsui, s.sui, s.suiPriceUsd, s.totalUsd, s.source ?? "chain", t],
    });
  } catch (e) {
    console.warn(`[snapshots] writeBalanceSnapshot failed: ${(e as Error)?.message ?? e}`);
  }
}

// ─── Activity snapshot ───────────────────────────────────────────────────

export type ActivitySnapshot = {
  userId: number;
  address: string;
  entries: unknown[];
  source: string;
  refreshedAt: number;
};

export async function readActivitySnapshot(userId: number): Promise<ActivitySnapshot | null> {
  try {
    await ensureSchema();
    const r = await db().execute({
      sql: `SELECT user_id, address, entries_json, source, refreshed_at
              FROM user_activity_snapshot WHERE user_id = $1 LIMIT 1`,
      args: [userId],
    });
    const row = r.rows[0];
    if (!row) return null;
    let entries: unknown[] = [];
    try {
      const parsed = JSON.parse(String(row.entries_json ?? "[]"));
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      return null;
    }
    return {
      userId: Number(row.user_id),
      address: String(row.address ?? ""),
      entries,
      source: String(row.source ?? "chain"),
      refreshedAt: Number(row.refreshed_at) || 0,
    };
  } catch {
    return null;
  }
}

export async function writeActivitySnapshot(s: {
  userId: number;
  address: string;
  entries: unknown[];
  limit: number;
  source?: string;
}): Promise<void> {
  try {
    await ensureSchema();
    const t = Date.now();
    const json = JSON.stringify(s.entries ?? []);
    await db().execute({
      sql: `INSERT INTO user_activity_snapshot
              (user_id, address, limit_n, entries_json, source, refreshed_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$6)
            ON CONFLICT (user_id) DO UPDATE SET
              address = EXCLUDED.address,
              limit_n = EXCLUDED.limit_n,
              entries_json = EXCLUDED.entries_json,
              source = EXCLUDED.source,
              refreshed_at = EXCLUDED.refreshed_at,
              updated_at = EXCLUDED.updated_at`,
      args: [s.userId, s.address, s.limit, json, s.source ?? "chain", t],
    });
  } catch (e) {
    console.warn(`[snapshots] writeActivitySnapshot failed: ${(e as Error)?.message ?? e}`);
  }
}

// ─── Insights snapshot ───────────────────────────────────────────────────

export type InsightsSnapshot = {
  userId: number;
  address: string;
  /** The exact MonthInsights payload /api/rewards/insights serialises. */
  insights: unknown;
  source: string;
  refreshedAt: number;
};

export async function readInsightsSnapshot(userId: number): Promise<InsightsSnapshot | null> {
  try {
    await ensureSchema();
    const r = await db().execute({
      sql: `SELECT user_id, address, insights_json, source, refreshed_at
              FROM user_insights_snapshot WHERE user_id = $1 LIMIT 1`,
      args: [userId],
    });
    const row = r.rows[0];
    if (!row) return null;
    let insights: unknown;
    try {
      insights = JSON.parse(String(row.insights_json ?? ""));
    } catch {
      return null;
    }
    if (!insights || typeof insights !== "object") return null;
    return {
      userId: Number(row.user_id),
      address: String(row.address ?? ""),
      insights,
      source: String(row.source ?? "chain"),
      refreshedAt: Number(row.refreshed_at) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Persist the last-known-good month insights. Callers must only write
 * snapshots computed from a COMPLETE activity read — a timed-out read's
 * zeros must never become the value we later serve as "last known".
 */
export async function writeInsightsSnapshot(s: {
  userId: number;
  address: string;
  insights: unknown;
  source?: string;
}): Promise<void> {
  try {
    await ensureSchema();
    const t = Date.now();
    const json = JSON.stringify(s.insights ?? {});
    await db().execute({
      sql: `INSERT INTO user_insights_snapshot
              (user_id, address, insights_json, source, refreshed_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$5)
            ON CONFLICT (user_id) DO UPDATE SET
              address = EXCLUDED.address,
              insights_json = EXCLUDED.insights_json,
              source = EXCLUDED.source,
              refreshed_at = EXCLUDED.refreshed_at,
              updated_at = EXCLUDED.updated_at`,
      args: [s.userId, s.address, json, s.source ?? "chain", t],
    });
  } catch (e) {
    console.warn(`[snapshots] writeInsightsSnapshot failed: ${(e as Error)?.message ?? e}`);
  }
}

// ─── Global key/value (shared across users + instances) ──────────────────

export async function getGlobalNum(
  k: string
): Promise<{ value: number; refreshedAt: number } | null> {
  try {
    await ensureSchema();
    const r = await db().execute({
      sql: `SELECT v_num, refreshed_at FROM global_kv WHERE k = $1 LIMIT 1`,
      args: [k],
    });
    const row = r.rows[0];
    if (!row || row.v_num == null) return null;
    return { value: Number(row.v_num) || 0, refreshedAt: Number(row.refreshed_at) || 0 };
  } catch {
    return null;
  }
}

export async function setGlobalNum(k: string, value: number): Promise<void> {
  try {
    await ensureSchema();
    const t = Date.now();
    await db().execute({
      sql: `INSERT INTO global_kv (k, v_num, refreshed_at) VALUES ($1,$2,$3)
            ON CONFLICT (k) DO UPDATE SET v_num = EXCLUDED.v_num, refreshed_at = EXCLUDED.refreshed_at`,
      args: [k, value, t],
    });
  } catch (e) {
    console.warn(`[snapshots] setGlobalNum failed: ${(e as Error)?.message ?? e}`);
  }
}
