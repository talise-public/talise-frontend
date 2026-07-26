import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { db } from "@/lib/db";
import { ensureShieldSchema } from "@/lib/shield/db";
import { SHIELD, shieldConfigured, shieldMaintenance } from "@/lib/shield/onchain";
import { USDSUI_TYPE } from "@/lib/usdsui";

export const runtime = "nodejs";

const MAX_PAGE = 200;

/**
 * GET /api/shield/disclose/locator
 *
 * The PUBLIC on-chain coordinates a note needs before it can be disclosed:
 * which leaf it is, which transaction created it, and when. `/api/shield/
 * commitments` already serves the commitment + ciphertext for scanning; this
 * route adds the two fields a disclosure receipt needs and that route omits —
 * `txDigest` (the chain anchor a third-party verifier looks the commitment up
 * in) and `createdAtMs` (so a date-range scope can be evaluated).
 *
 * Query, one of:
 *   ?commitment=<u256 decimal>          → the locator for one commitment
 *   ?fromLeafIndex=&toLeafIndex=&limit= → locators for a leaf range
 *
 * Every field returned is already public: commitments, leaf indices, and
 * transaction digests are all on chain. NOTHING secret passes through here —
 * no blinding factor, no viewing key, no note plaintext. The server cannot
 * build a disclosure and is not asked to.
 *
 * GATES: `shieldMaintenance()` first (this whole feature ships dark behind it),
 * then `shieldConfigured()`, then authentication. Read-only, not money-moving.
 */
export async function GET(req: Request) {
  if (shieldMaintenance()) {
    return NextResponse.json(
      { error: "Private sends are currently in maintenance.", code: "SHIELD_MAINTENANCE" },
      { status: 503 }
    );
  }
  if (!shieldConfigured()) {
    return NextResponse.json({ error: "privacy not yet live", code: "SHIELD_OFF" }, { status: 503 });
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const url = new URL(req.url);
  const coinType = url.searchParams.get("coinType") || USDSUI_TYPE;
  const commitment = url.searchParams.get("commitment");
  const fromRaw = url.searchParams.get("fromLeafIndex");
  const toRaw = url.searchParams.get("toLeafIndex");
  const limitRaw = url.searchParams.get("limit");

  await ensureShieldSchema();

  const base = {
    coinType,
    packageId: SHIELD.packageId,
    poolObjectId: SHIELD.poolUsdsui,
  };

  if (commitment !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(commitment)) {
      return NextResponse.json(
        { error: "commitment must be a u256 decimal string" },
        { status: 400 }
      );
    }
    const r = await db().execute({
      sql: `SELECT leaf_index, commitment, digest, created_at
              FROM shield_commitments
             WHERE coin_type = ? AND commitment = ?
             LIMIT 1`,
      args: [coinType, commitment],
    });
    const row = r.rows[0] as
      | { leaf_index: number; commitment: string; digest: string | null; created_at: number }
      | undefined;
    if (!row) {
      return NextResponse.json({ error: "commitment not indexed", code: "NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json({ ...base, item: toItem(row) });
  }

  if (fromRaw !== null || toRaw !== null) {
    const from = fromRaw !== null && /^\d+$/.test(fromRaw) ? Number(fromRaw) : 0;
    const to = toRaw !== null && /^\d+$/.test(toRaw) ? Number(toRaw) : Number.MAX_SAFE_INTEGER;
    if (to < from) {
      return NextResponse.json({ error: "toLeafIndex < fromLeafIndex" }, { status: 400 });
    }
    let limit = limitRaw !== null && /^\d+$/.test(limitRaw) ? Number(limitRaw) : MAX_PAGE;
    limit = Math.max(1, Math.min(MAX_PAGE, limit));
    const r = await db().execute({
      sql: `SELECT leaf_index, commitment, digest, created_at
              FROM shield_commitments
             WHERE coin_type = ? AND leaf_index >= ? AND leaf_index <= ?
             ORDER BY leaf_index ASC
             LIMIT ?`,
      args: [coinType, from, to, limit],
    });
    const rows = r.rows as Array<{
      leaf_index: number;
      commitment: string;
      digest: string | null;
      created_at: number;
    }>;
    return NextResponse.json({ ...base, items: rows.map(toItem), count: rows.length });
  }

  return NextResponse.json(
    { error: "pass ?commitment= or ?fromLeafIndex=/?toLeafIndex=" },
    { status: 400 }
  );
}

function toItem(row: {
  leaf_index: number;
  commitment: string;
  digest: string | null;
  created_at: number;
}) {
  return {
    leafIndex: row.leaf_index,
    commitment: row.commitment,
    /** The transaction that emitted this leaf's `NewCommitment`. */
    txDigest: row.digest,
    /** Chain timestamp of that event (ms), the basis for a date-range scope. */
    createdAtMs: row.created_at,
  };
}
