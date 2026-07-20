import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { requireAdminApi } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/users
 *
 *  - ?id=<number>  → ONE user: full users row + aggregates
 *                    { user, stats: { txCount, transferCount } }.
 *  - else LIST     → paginated, filterable list:
 *                    { rows, total, page, pageSize }.
 *
 * Read-only. Tolerates a cold/empty DB (a failed sub-query yields a
 * sensible default rather than 500-ing the page).
 */

const PAGE_SIZE = 50;

export async function GET(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;

  await ensureSchema().catch(() => {});

  const url = new URL(req.url);
  const idParam = url.searchParams.get("id");

  // ─── Single user detail ──────────────────────────────────────────
  if (idParam != null && idParam !== "") {
    const id = Number(idParam);
    if (!Number.isFinite(id) || !Number.isInteger(id)) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }

    let user: Record<string, unknown> | null = null;
    try {
      const r = await db().execute({
        sql: `SELECT * FROM users WHERE id = $1`,
        args: [id],
      });
      user = (r.rows[0] as Record<string, unknown> | undefined) ?? null;
    } catch {
      user = null;
    }

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // tx_history.user_id is the users.id; transfers.user_id is TEXT.
    const txCount = await scalar(
      `SELECT COUNT(*) FROM tx_history WHERE user_id = $1`,
      [id]
    );
    const transferCount = await scalar(
      `SELECT COUNT(*) FROM transfers WHERE user_id = $1::text`,
      [id]
    );

    return NextResponse.json({
      user,
      stats: { txCount, transferCount },
    });
  }

  // ─── List ────────────────────────────────────────────────────────
  const q = (url.searchParams.get("q") ?? "").trim();
  const tierParam = url.searchParams.get("tier") ?? "all";
  const typeParam = url.searchParams.get("type") ?? "all";
  const pageRaw = Number(url.searchParams.get("page") ?? "0");
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 0;

  const where: string[] = [];
  const args: unknown[] = [];

  if (q) {
    args.push(`%${q}%`);
    const p = `$${args.length}`;
    where.push(
      `(email ILIKE ${p} OR talise_username ILIKE ${p} OR sui_address ILIKE ${p} OR name ILIKE ${p})`
    );
  }

  // tier: 'all' | '0'..'3', treat NULL as 0.
  const TIERS = new Set(["0", "1", "2", "3"]);
  if (tierParam !== "all" && TIERS.has(tierParam)) {
    args.push(Number(tierParam));
    where.push(`COALESCE(kyc_tier, 0) = $${args.length}`);
  }

  // type: 'all' | 'personal' | 'business', NULL counts as personal.
  if (typeParam === "personal") {
    where.push(`COALESCE(account_type, 'personal') = 'personal'`);
  } else if (typeParam === "business") {
    where.push(`COALESCE(account_type, 'personal') = 'business'`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  let total = 0;
  try {
    total = await scalar(`SELECT COUNT(*) FROM users ${whereSql}`, args);
  } catch {
    total = 0;
  }

  let rows: Array<Record<string, unknown>> = [];
  try {
    const limitIdx = args.length + 1;
    const offsetIdx = args.length + 2;
    const r = await db().execute({
      sql: `SELECT id, email, talise_username, account_type, country,
                   COALESCE(kyc_tier, 0) AS kyc_tier, points_total,
                   lifetime_sent_usd, created_at, last_seen_at
            FROM users
            ${whereSql}
            ORDER BY created_at DESC NULLS LAST
            LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      args: [...args, PAGE_SIZE, page * PAGE_SIZE],
    });
    rows = r.rows as Array<Record<string, unknown>>;
  } catch {
    rows = [];
  }

  return NextResponse.json({
    rows,
    total,
    page,
    pageSize: PAGE_SIZE,
  });
}

/** Run a single-scalar COUNT/SUM query and Number() the result. */
async function scalar(
  sql: string,
  args: ReadonlyArray<unknown> = []
): Promise<number> {
  try {
    const r = await db().execute({ sql, args });
    const v = r.rows[0] ? Object.values(r.rows[0])[0] : 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
