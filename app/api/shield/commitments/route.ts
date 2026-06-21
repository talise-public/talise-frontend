import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { shieldConfigured } from "@/lib/shield/onchain";
import { ensureShieldSchema } from "@/lib/shield/db";
import { db } from "@/lib/db";
import { USDSUI_TYPE } from "@/lib/usdsui";

export const runtime = "nodejs";

const MAX_PAGE = 200;
const DEFAULT_PAGE = 100;

/**
 * GET /api/shield/commitments?coinType=&after=<leafIndex>&limit=
 *
 * Cursor-paginated stream of indexed commitments (Merkle leaves) in ascending
 * leaf order, so the SDK can trial-decrypt every `encrypted_output` to find
 * notes addressed to the user (the scan path). `after` is an exclusive
 * leaf-index cursor; the response echoes `nextCursor` (the last leaf_index, or
 * null when drained).
 *
 * NOT money-moving (it's the receive/scan side — like reading inbound
 * activity), so gated behind auth only, not app-approval. Dormant → 503.
 */
export async function GET(req: Request) {
  if (!shieldConfigured()) {
    return NextResponse.json({ error: "privacy not yet live", code: "SHIELD_OFF" }, { status: 503 });
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const url = new URL(req.url);
  const coinType = url.searchParams.get("coinType") || USDSUI_TYPE;
  const afterRaw = url.searchParams.get("after");
  const limitRaw = url.searchParams.get("limit");

  const after = afterRaw !== null && /^\d+$/.test(afterRaw) ? Number(afterRaw) : -1;
  let limit = limitRaw !== null && /^\d+$/.test(limitRaw) ? Number(limitRaw) : DEFAULT_PAGE;
  limit = Math.max(1, Math.min(MAX_PAGE, limit));

  await ensureShieldSchema();
  const r = await db().execute({
    sql: `SELECT leaf_index, commitment, encrypted_output, digest, checkpoint
          FROM shield_commitments
          WHERE coin_type = ? AND leaf_index > ?
          ORDER BY leaf_index ASC
          LIMIT ?`,
    args: [coinType, after, limit],
  });

  const rows = r.rows as Array<{
    leaf_index: number;
    commitment: string;
    encrypted_output: string | null;
    digest: string | null;
    checkpoint: number | null;
  }>;

  const items = rows.map((row) => ({
    leafIndex: row.leaf_index,
    commitment: row.commitment,
    encryptedOutput: row.encrypted_output,
    digest: row.digest,
    checkpoint: row.checkpoint,
  }));

  const nextCursor =
    items.length === limit ? items[items.length - 1].leafIndex : null;

  return NextResponse.json({ coinType, items, nextCursor, count: items.length });
}
