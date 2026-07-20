import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { requireAdminApi } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/transactions, the headline section. Successful /
 * pending / failed across the three transaction sources:
 *
 *   onchain   = tx_history (post-confirmation ⇒ always "success")
 *   transfers = transfers (cross-border state machine)
 *   linq      = linq_offramps (USDSUI → NGN payouts via Linq)
 *
 * Read-only, paginated (pageSize 50), admin-gated. A cold/empty/absent
 * table yields {rows:[],total:0,…} rather than a 500.
 *
 * Params: source ('onchain'|'transfers'|'linq'), status
 * ('all'|'success'|'pending'|'failed'), q (free text), page (0-based).
 * Returns { source, rows, total, page, pageSize, counts:{all,success,
 * pending,failed} } where counts are for the active source.
 */

const PAGE_SIZE = 50;

type Source = "onchain" | "transfers" | "linq";
type StatusFilter = "all" | "success" | "pending" | "failed";
type Bucket = "success" | "pending" | "failed";

const SOURCES: Source[] = ["onchain", "transfers", "linq"];
const STATUSES: StatusFilter[] = ["all", "success", "pending", "failed"];

function whitelistSource(v: string | null): Source {
  return SOURCES.includes(v as Source) ? (v as Source) : "onchain";
}
function whitelistStatus(v: string | null): StatusFilter {
  return STATUSES.includes(v as StatusFilter) ? (v as StatusFilter) : "all";
}

/** State/status string → success|pending|failed bucket, per source. */
function transferBucket(state: string | null | undefined): Bucket {
  const s = (state ?? "").toLowerCase();
  if (s === "settled" || s === "onchain_settled") return "success";
  if (s === "failed" || s === "refunded") return "failed";
  return "pending";
}
function linqBucket(status: string | null | undefined): Bucket {
  const s = (status ?? "").toLowerCase();
  if (/settled|success|disbursed|completed/.test(s)) return "success";
  if (/failed|reject|timeout/.test(s)) return "failed";
  return "pending";
}

/** Map a bucket to the SQL state values it covers (for transfers). */
const TRANSFER_SUCCESS_STATES = ["settled", "onchain_settled"];
const TRANSFER_FAILED_STATES = ["failed", "refunded"];

async function safeRows(
  sql: string,
  args: ReadonlyArray<unknown> = []
): Promise<Array<Record<string, unknown>>> {
  try {
    const r = await db().execute({ sql, args });
    return r.rows as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

async function safeCount(sql: string, args: ReadonlyArray<unknown> = []): Promise<number> {
  try {
    const r = await db().execute({ sql, args });
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
  const source = whitelistSource(url.searchParams.get("source"));
  const status = whitelistStatus(url.searchParams.get("status"));
  const q = (url.searchParams.get("q") ?? "").trim();
  const page = Math.max(0, Number(url.searchParams.get("page") ?? 0) || 0);
  const offset = page * PAGE_SIZE;
  const like = `%${q}%`;

  if (source === "onchain") {
    return NextResponse.json(
      await onchain({ status, q, like, page, offset })
    );
  }
  if (source === "transfers") {
    return NextResponse.json(
      await transfers({ status, q, like, page, offset })
    );
  }
  return NextResponse.json(await linq({ status, q, like, page, offset }));
}

type QueryArgs = {
  status: StatusFilter;
  q: string;
  like: string;
  page: number;
  offset: number;
};

// ─── onchain (tx_history) ──────────────────────────────────────────
// Rows are recorded only post-confirmation ⇒ every row is "success".
// status 'pending'/'failed' therefore yield an empty set.

async function onchain({ status, q, like, page, offset }: QueryArgs) {
  const counts = { all: 0, success: 0, pending: 0, failed: 0 };
  counts.all = await safeCount(`SELECT COUNT(*) FROM tx_history`);
  counts.success = counts.all;

  // A non-success status filter matches nothing for this source.
  if (status === "pending" || status === "failed") {
    return { source: "onchain", rows: [], total: 0, page, pageSize: PAGE_SIZE, counts };
  }

  const where: string[] = [];
  const args: unknown[] = [];
  if (q) {
    args.push(like);
    const a = `$${args.length}`;
    args.push(like);
    const b = `$${args.length}`;
    args.push(like);
    const c = `$${args.length}`;
    where.push(`(t.digest ILIKE ${a} OR t.recipient ILIKE ${b} OR u.email ILIKE ${c})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = await safeCount(
    `SELECT COUNT(*) FROM tx_history t LEFT JOIN users u ON t.user_id = u.id ${whereSql}`,
    args
  );

  const rows = await safeRows(
    `SELECT t.id, t.created_at, t.user_id, u.email AS user_email, t.kind,
            t.amount, t.asset, t.recipient, t.digest, t.memo, t.receipt_object_id
       FROM tx_history t
       LEFT JOIN users u ON t.user_id = u.id
       ${whereSql}
      ORDER BY t.created_at DESC NULLS LAST
      LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
    args
  );

  return {
    source: "onchain",
    rows: rows.map((r) => ({ ...r, bucket: "success" as Bucket })),
    total,
    page,
    pageSize: PAGE_SIZE,
    counts,
  };
}

// ─── transfers ─────────────────────────────────────────────────────

async function transfers({ status, q, like, page, offset }: QueryArgs) {
  const counts = { all: 0, success: 0, pending: 0, failed: 0 };

  // Bucket counts via a single GROUP BY over state.
  const stateGroups = await safeRows(
    `SELECT state, COUNT(*) AS n FROM transfers GROUP BY state`
  );
  for (const g of stateGroups) {
    const n = Number(g.n ?? 0);
    counts.all += n;
    counts[transferBucket(String(g.state ?? ""))] += n;
  }

  const where: string[] = [];
  const args: unknown[] = [];

  // status bucket → IN / NOT IN clause over whitelisted state literals.
  if (status === "success") {
    const ph = TRANSFER_SUCCESS_STATES.map((s) => {
      args.push(s);
      return `$${args.length}`;
    });
    where.push(`state IN (${ph.join(",")})`);
  } else if (status === "failed") {
    const ph = TRANSFER_FAILED_STATES.map((s) => {
      args.push(s);
      return `$${args.length}`;
    });
    where.push(`state IN (${ph.join(",")})`);
  } else if (status === "pending") {
    const all = [...TRANSFER_SUCCESS_STATES, ...TRANSFER_FAILED_STATES];
    const ph = all.map((s) => {
      args.push(s);
      return `$${args.length}`;
    });
    where.push(`(state IS NULL OR state NOT IN (${ph.join(",")}))`);
  }

  if (q) {
    args.push(like);
    const a = `$${args.length}`;
    args.push(like);
    const b = `$${args.length}`;
    args.push(like);
    const c = `$${args.length}`;
    where.push(`(onchain_digest ILIKE ${a} OR provider_reference ILIKE ${b} OR user_id ILIKE ${c})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = await safeCount(`SELECT COUNT(*) FROM transfers ${whereSql}`, args);

  const rows = await safeRows(
    `SELECT id, created_at, user_id, kind, provider, source_currency, dest_currency,
            source_amount, dest_amount, usdsui_amount, fx_rate, state, onchain_digest,
            provider_reference, parked_funds, state_reason, metadata, updated_at,
            debited_at, onchain_settled_at, settled_at, failed_at
       FROM transfers
       ${whereSql}
      ORDER BY created_at DESC NULLS LAST
      LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
    args
  );

  return {
    source: "transfers",
    rows: rows.map((r) => ({ ...r, bucket: transferBucket(String(r.state ?? "")) })),
    total,
    page,
    pageSize: PAGE_SIZE,
    counts,
  };
}

// ─── linq (linq_offramps) ──────────────────────────────────────────

async function linq({ status, q, like, page, offset }: QueryArgs) {
  const counts = { all: 0, success: 0, pending: 0, failed: 0 };

  const statusGroups = await safeRows(
    `SELECT status, COUNT(*) AS n FROM linq_offramps GROUP BY status`
  );
  for (const g of statusGroups) {
    const n = Number(g.n ?? 0);
    counts.all += n;
    counts[linqBucket(String(g.status ?? ""))] += n;
  }

  // Linq buckets are regex over an open status vocabulary, so the
  // filter is applied in SQL via ILIKE patterns rather than IN-lists.
  const where: string[] = [];
  const args: unknown[] = [];

  if (status === "success") {
    where.push(
      `(LOWER(status) LIKE '%settled%' OR LOWER(status) LIKE '%success%' OR LOWER(status) LIKE '%disbursed%' OR LOWER(status) LIKE '%completed%')`
    );
  } else if (status === "failed") {
    where.push(`(LOWER(status) LIKE '%failed%' OR LOWER(status) LIKE '%reject%' OR LOWER(status) LIKE '%timeout%')`);
  } else if (status === "pending") {
    where.push(
      `(status IS NULL OR (LOWER(status) NOT LIKE '%settled%' AND LOWER(status) NOT LIKE '%success%' AND LOWER(status) NOT LIKE '%disbursed%' AND LOWER(status) NOT LIKE '%completed%' AND LOWER(status) NOT LIKE '%failed%' AND LOWER(status) NOT LIKE '%reject%' AND LOWER(status) NOT LIKE '%timeout%'))`
    );
  }

  if (q) {
    args.push(like);
    const a = `$${args.length}`;
    args.push(like);
    const b = `$${args.length}`;
    args.push(like);
    const c = `$${args.length}`;
    where.push(`(linq_order_id ILIKE ${a} OR bank_account_number ILIKE ${b} OR user_id ILIKE ${c})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = await safeCount(`SELECT COUNT(*) FROM linq_offramps ${whereSql}`, args);

  const rows = await safeRows(
    `SELECT id, linq_order_id, created_at, user_id, amount_usdsui, amount_ngn, rate, bank_code,
            bank_account_number, bank_account_name, wallet_address, status, status_reason, updated_at
       FROM linq_offramps
       ${whereSql}
      ORDER BY created_at DESC NULLS LAST
      LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
    args
  );

  return {
    source: "linq",
    rows: rows.map((r) => ({ ...r, bucket: linqBucket(String(r.status ?? "")) })),
    total,
    page,
    pageSize: PAGE_SIZE,
    counts,
  };
}
