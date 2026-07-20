import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { requireAdminApi } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/raw, generic READ-ONLY table browser.
 *
 *   (no ?table)            → { tables: [{ table, rowCount }] }, COUNT(*) per
 *                            whitelisted table; rowCount null if it errors/absent.
 *   ?table=<x>&page=<n>    → { table, columns, rows, total, page, pageSize }
 *                            400 if <x> is not whitelisted.
 *
 * Only whitelisted table names ever reach SQL, and ordering uses a static
 * per-table column (never user input). SELECT only.
 */

const PAGE_SIZE = 50;

// Exactly these tables, in display order. Nothing else is queryable.
const WHITELIST = [
  "users",
  "tx_history",
  "invoices",
  "rewards_events",
  "savings_goals",
  "redemptions",
  "waitlist",
  "waitlist_signups",
  "linq_offramps",
  "transfers",
  "roundup_queue",
  "float_pools",
  "kyc_upgrade_intents",
  "travel_rule_records",
  "mobile_sessions",
] as const;

type RawTable = (typeof WHITELIST)[number];
const WHITELIST_SET: ReadonlySet<string> = new Set(WHITELIST);

/**
 * Static, safe ORDER BY clause per table. We choose a column we know to be
 * sortable + indexed-ish; the value is a constant string we control, never
 * derived from the request. Tables keyed on `email` (waitlist_signups) sort
 * by created_at; everything else prefers id then created_at.
 */
const ORDER_BY: Record<RawTable, string> = {
  users: "created_at DESC",
  tx_history: "created_at DESC",
  invoices: "created_at DESC",
  rewards_events: "created_at DESC",
  savings_goals: "created_at DESC",
  redemptions: "created_at DESC",
  waitlist: "created_at DESC",
  waitlist_signups: "created_at DESC",
  linq_offramps: "created_at DESC",
  transfers: "created_at DESC",
  roundup_queue: "created_at DESC",
  float_pools: "created_at DESC",
  kyc_upgrade_intents: "created_at DESC",
  travel_rule_records: "created_at DESC",
  mobile_sessions: "created_at DESC",
};

/**
 * Fallback column lists used when a page comes back empty (so the table UI
 * still has headers to render). Best-effort; the real columns always come
 * from the first row's keys when rows exist.
 */
const FALLBACK_COLUMNS: Record<RawTable, string[]> = {
  users: ["id", "email", "name", "sui_address", "country", "account_type", "kyc_tier", "points_total", "created_at", "last_seen_at"],
  tx_history: ["id", "user_id", "digest", "kind", "amount", "asset", "recipient", "memo", "created_at"],
  invoices: ["id", "business_user_id", "slug", "amount_usdc", "reference", "customer_email", "status", "created_at", "paid_at", "paid_digest"],
  rewards_events: ["id", "user_id", "kind", "points", "metadata", "created_at"],
  savings_goals: ["id", "user_id", "name", "target_usd", "current_usd", "deadline_ms", "color", "archived", "created_at"],
  redemptions: ["id", "user_id", "sku", "points_spent", "status", "metadata", "created_at", "fulfilled_at"],
  waitlist: ["id", "email", "created_at", "source", "invited_at", "name", "country", "reason"],
  waitlist_signups: ["email", "created_at", "ip", "confirmation_sent", "confirmation_sent_at", "claimed_handle", "handle_bound_user_id"],
  linq_offramps: ["id", "linq_order_id", "user_id", "amount_usdsui", "amount_ngn", "rate", "bank_code", "wallet_address", "status", "created_at"],
  transfers: ["id", "user_id", "kind", "provider", "state", "source_currency", "dest_currency", "usdsui_amount", "fx_rate", "created_at", "updated_at"],
  roundup_queue: ["id", "user_id", "amount_usd", "created_at", "processed_at", "tx_digest"],
  float_pools: ["id", "corridor", "currency", "leg", "fiat_in_pool", "fiat_out_pool", "usdc_pool", "created_at", "updated_at"],
  kyc_upgrade_intents: ["id", "user_id", "from_tier", "requested_tier", "ekyc_provider", "ekyc_ref", "ekyc_status", "created_at"],
  travel_rule_records: ["id", "user_id", "route", "obligation", "amount_usd", "recipient_kind", "beneficiary_address", "status", "created_at"],
  mobile_sessions: ["id", "user_id", "created_at"],
};

async function countOne(table: RawTable): Promise<number | null> {
  try {
    // table is from a fixed whitelist, safe to inline.
    const r = await db().execute({ sql: `SELECT COUNT(*) FROM ${table}`, args: [] });
    const v = r.rows[0] ? Object.values(r.rows[0])[0] : 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;

  await ensureSchema().catch(() => {});

  const url = new URL(req.url);
  const table = url.searchParams.get("table");

  // No table → directory of whitelisted tables + row counts.
  if (!table) {
    const tables = await Promise.all(
      WHITELIST.map(async (t) => ({ table: t, rowCount: await countOne(t) }))
    );
    return NextResponse.json({ tables });
  }

  // Reject anything not on the whitelist.
  if (!WHITELIST_SET.has(table)) {
    return NextResponse.json({ error: "Unknown or non-browsable table." }, { status: 400 });
  }
  const t = table as RawTable;

  const pageParam = Number(url.searchParams.get("page") ?? 0);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 0;
  const offset = page * PAGE_SIZE;

  let rows: Array<Record<string, unknown>> = [];
  try {
    // table + ORDER_BY[t] are both constants we control; only LIMIT/OFFSET bind.
    const r = await db().execute({
      sql: `SELECT * FROM ${t} ORDER BY ${ORDER_BY[t]} LIMIT $1 OFFSET $2`,
      args: [PAGE_SIZE, offset],
    });
    rows = r.rows as Array<Record<string, unknown>>;
  } catch {
    // Ordering column may not exist on this DB, retry without ORDER BY.
    try {
      const r = await db().execute({
        sql: `SELECT * FROM ${t} LIMIT $1 OFFSET $2`,
        args: [PAGE_SIZE, offset],
      });
      rows = r.rows as Array<Record<string, unknown>>;
    } catch {
      rows = [];
    }
  }

  const total = await countOne(t);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : FALLBACK_COLUMNS[t];

  return NextResponse.json({
    table: t,
    columns,
    rows,
    total: total ?? 0,
    page,
    pageSize: PAGE_SIZE,
  });
}
