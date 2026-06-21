import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { requireAdminApi } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/waitlist — read-only browser over the two waitlist
 * tables.
 *
 *   list   'signups' (canonical waitlist_signups) | 'legacy' (waitlist)
 *   filter 'all' | 'confirmed' | 'unconfirmed' | 'claimed'
 *   q      ILIKE match on email (and claimed_handle for signups)
 *   page   0-based, pageSize fixed at 50
 *
 * Returns { list, rows, total, page, pageSize, counts }. Resilient to a
 * cold DB where a table may be empty or absent (yields 0 / [] rather
 * than 500-ing).
 */

const PAGE_SIZE = 50;

const LISTS = new Set(["signups", "legacy"]);
const FILTERS = new Set(["all", "confirmed", "unconfirmed", "claimed"]);

async function scalar(sql: string, args: ReadonlyArray<unknown> = []): Promise<number> {
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

  const listParam = url.searchParams.get("list") ?? "signups";
  const list = LISTS.has(listParam) ? listParam : "signups";

  const filterParam = url.searchParams.get("filter") ?? "all";
  const filter = FILTERS.has(filterParam) ? filterParam : "all";

  const q = (url.searchParams.get("q") ?? "").trim();

  const pageRaw = Number(url.searchParams.get("page") ?? 0);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 0;
  const offset = page * PAGE_SIZE;

  // Always-fresh headline counts (independent of the active filter/search).
  const [signups, legacy, confirmed, claimed] = await Promise.all([
    scalar(`SELECT COUNT(*) FROM waitlist_signups`),
    scalar(`SELECT COUNT(*) FROM waitlist`),
    scalar(`SELECT COUNT(*) FROM waitlist_signups WHERE confirmation_sent = true`),
    scalar(`SELECT COUNT(*) FROM waitlist_signups WHERE claimed_handle IS NOT NULL`),
  ]);
  const counts = { signups, legacy, confirmed, claimed };

  // Build the WHERE clause from whitelisted conditions only — no raw
  // interpolation of user input.
  const where: string[] = [];
  const args: unknown[] = [];

  if (list === "signups") {
    if (filter === "confirmed") where.push(`confirmation_sent = true`);
    else if (filter === "unconfirmed")
      where.push(`(confirmation_sent IS NULL OR confirmation_sent = false)`);
    else if (filter === "claimed") where.push(`claimed_handle IS NOT NULL`);

    if (q) {
      args.push(`%${q}%`);
      const p = `$${args.length}`;
      where.push(`(email ILIKE ${p} OR claimed_handle ILIKE ${p})`);
    }
  } else {
    // legacy waitlist — 'claimed' filter is N/A, treat as 'all'.
    if (filter === "confirmed") where.push(`confirmation_sent_at IS NOT NULL`);
    else if (filter === "unconfirmed") where.push(`confirmation_sent_at IS NULL`);

    if (q) {
      args.push(`%${q}%`);
      where.push(`email ILIKE $${args.length}`);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const table = list === "signups" ? "waitlist_signups" : "waitlist";
  const selectCols =
    list === "signups"
      ? `email, created_at, confirmation_sent, confirmation_sent_at, ip, user_agent,
         claimed_handle, handle_claimed_at, handle_object_id, handle_bound_user_id, handle_bound_at`
      : `id, email, name, country, source, reason, created_at, invited_at, confirmation_sent_at`;

  let rows: Array<Record<string, unknown>> = [];
  let total = 0;

  try {
    total = await scalar(`SELECT COUNT(*) FROM ${table} ${whereSql}`, args);

    const listArgs = [...args, PAGE_SIZE, offset];
    const limitP = `$${listArgs.length - 1}`;
    const offsetP = `$${listArgs.length}`;
    const r = await db().execute({
      sql: `SELECT ${selectCols} FROM ${table} ${whereSql}
            ORDER BY created_at DESC NULLS LAST
            LIMIT ${limitP} OFFSET ${offsetP}`,
      args: listArgs,
    });
    rows = r.rows as Array<Record<string, unknown>>;
  } catch {
    rows = [];
    total = 0;
  }

  return NextResponse.json({
    list,
    filter,
    q,
    rows,
    total,
    page,
    pageSize: PAGE_SIZE,
    counts,
  });
}
