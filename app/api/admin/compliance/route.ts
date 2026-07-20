import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { requireAdminApi } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/compliance, read-only window into the compliance &
 * treasury tables. `tab` selects which dataset; everything is paginated
 * (pageSize 50) and resilient: a missing/empty table yields an empty
 * page rather than a 500.
 *
 * tabs:
 *   kyc     → kyc_upgrade_intents (+ users.email)
 *   travel  → travel_rule_records
 *   float   → float_pools (every column, ordered corridor/currency/leg)
 *   roundup → roundup_queue
 */

const PAGE_SIZE = 50;

// Whitelist of valid tabs → never interpolate raw user input into SQL.
const TABS = ["kyc", "travel", "float", "roundup"] as const;
type Tab = (typeof TABS)[number];

function isTab(v: string | null): v is Tab {
  return v != null && (TABS as readonly string[]).includes(v);
}

/** COUNT(*) for `table`; 0 if the table is absent/empty. */
async function countRows(sql: string): Promise<number> {
  try {
    const r = await db().execute({ sql, args: [] });
    const v = r.rows[0] ? Object.values(r.rows[0])[0] : 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** Run a paginated SELECT; [] if the table is absent. */
async function selectRows(
  sql: string,
  args: ReadonlyArray<unknown>
): Promise<Array<Record<string, unknown>>> {
  try {
    const r = await db().execute({ sql, args });
    return r.rows as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;

  await ensureSchema().catch(() => {});

  const url = new URL(req.url);
  const rawTab = url.searchParams.get("tab");
  const tab: Tab = isTab(rawTab) ? rawTab : "kyc";

  const rawPage = Number(url.searchParams.get("page") ?? 0);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 0;
  const offset = page * PAGE_SIZE;

  let total = 0;
  let rows: Array<Record<string, unknown>> = [];

  if (tab === "kyc") {
    total = await countRows(`SELECT COUNT(*) FROM kyc_upgrade_intents`);
    rows = await selectRows(
      `SELECT k.id, k.user_id, u.email AS email, k.from_tier, k.requested_tier,
              k.ekyc_provider, k.ekyc_ref, k.ekyc_status, k.created_at
         FROM kyc_upgrade_intents k
         LEFT JOIN users u ON u.id = k.user_id
        ORDER BY k.created_at DESC
        LIMIT $1 OFFSET $2`,
      [PAGE_SIZE, offset]
    );
  } else if (tab === "travel") {
    total = await countRows(`SELECT COUNT(*) FROM travel_rule_records`);
    rows = await selectRows(
      `SELECT id, user_id, route, obligation, amount_usd, recipient_kind,
              beneficiary_address, network_transfer_id, status, ivms101_json, created_at
         FROM travel_rule_records
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2`,
      [PAGE_SIZE, offset]
    );
  } else if (tab === "float") {
    total = await countRows(`SELECT COUNT(*) FROM float_pools`);
    rows = await selectRows(
      `SELECT id, corridor, currency, leg, fiat_in_pool, fiat_out_pool, usdc_pool,
              segregated, reconciled_at, created_at, updated_at
         FROM float_pools
        ORDER BY corridor, currency, leg
        LIMIT $1 OFFSET $2`,
      [PAGE_SIZE, offset]
    );
  } else {
    // roundup
    total = await countRows(`SELECT COUNT(*) FROM roundup_queue`);
    rows = await selectRows(
      `SELECT id, user_id, amount_usd, created_at, processed_at, tx_digest
         FROM roundup_queue
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2`,
      [PAGE_SIZE, offset]
    );
  }

  return NextResponse.json({ tab, rows, total, page, pageSize: PAGE_SIZE });
}
