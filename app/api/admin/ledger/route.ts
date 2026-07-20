import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { requireAdminApi } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/ledger, rewards / commerce ledger, read-only.
 *
 * Params:
 *   tab, 'rewards' | 'goals' | 'redemptions' | 'invoices' (default 'rewards')
 *   page, 0-based page, pageSize 50.
 *
 * Whitelisted tab drives a fixed SELECT (no raw interpolation). A cold /
 * empty / absent table yields { rows: [], total: 0 } rather than a 500.
 */

const PAGE_SIZE = 50;

type Tab = "rewards" | "goals" | "redemptions" | "invoices";
const TABS: ReadonlySet<Tab> = new Set<Tab>(["rewards", "goals", "redemptions", "invoices"]);

// Per-tab SELECT (data) + COUNT query. No user input is ever interpolated.
const QUERIES: Record<Tab, { rows: string; count: string }> = {
  rewards: {
    rows: `
      SELECT r.id, r.user_id, u.email, r.kind, r.points, r.metadata, r.created_at
      FROM rewards_events r
      LEFT JOIN users u ON u.id = r.user_id
      ORDER BY r.created_at DESC
      LIMIT $1 OFFSET $2`,
    count: `SELECT COUNT(*) FROM rewards_events`,
  },
  goals: {
    rows: `
      SELECT id, user_id, name, target_usd, current_usd, deadline_ms, color, archived, created_at
      FROM savings_goals
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2`,
    count: `SELECT COUNT(*) FROM savings_goals`,
  },
  redemptions: {
    rows: `
      SELECT id, user_id, sku, points_spent, status, metadata, created_at, fulfilled_at
      FROM redemptions
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2`,
    count: `SELECT COUNT(*) FROM redemptions`,
  },
  invoices: {
    rows: `
      SELECT i.id, i.business_user_id, u.email, i.slug, i.amount_usdc, i.reference,
             i.customer_email, i.status, i.created_at, i.paid_at, i.paid_digest, i.paid_by_address
      FROM invoices i
      LEFT JOIN users u ON u.id = i.business_user_id
      ORDER BY i.created_at DESC
      LIMIT $1 OFFSET $2`,
    count: `SELECT COUNT(*) FROM invoices`,
  },
};

async function safeRows(sql: string, args: ReadonlyArray<unknown>): Promise<Array<Record<string, unknown>>> {
  try {
    const r = await db().execute({ sql, args });
    return r.rows as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

async function safeCount(sql: string): Promise<number> {
  try {
    const r = await db().execute({ sql, args: [] });
    const v = r.rows[0] ? Object.values(r.rows[0])[0] : 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export async function GET(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;

  await ensureSchema().catch(() => {});

  const url = new URL(req.url);
  const rawTab = url.searchParams.get("tab") ?? "rewards";
  const tab: Tab = TABS.has(rawTab as Tab) ? (rawTab as Tab) : "rewards";

  const pageParam = Number(url.searchParams.get("page") ?? 0);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 0;
  const offset = page * PAGE_SIZE;

  const q = QUERIES[tab];
  const [rows, total] = await Promise.all([
    safeRows(q.rows, [PAGE_SIZE, offset]),
    safeCount(q.count),
  ]);

  return NextResponse.json({ tab, rows, total, page, pageSize: PAGE_SIZE });
}
