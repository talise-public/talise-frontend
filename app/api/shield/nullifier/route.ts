import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { shieldConfigured } from "@/lib/shield/onchain";
import { ensureShieldSchema } from "@/lib/shield/db";
import { db } from "@/lib/db";
import { USDSUI_TYPE } from "@/lib/usdsui";

export const runtime = "nodejs";

/**
 * GET /api/shield/nullifier?coinType=&nullifier=<u256>
 *
 * Existence check used during the spend flow: is this input note's nullifier
 * already spent (indexed from a NullifierSpent event)? The relayer/client
 * pre-checks here to avoid building a proof that will abort on-chain. Accepts a
 * comma-separated `nullifier` list (the 2-in shape needs both) and returns a
 * per-nullifier `spent` map.
 *
 * Gated behind auth (it's part of a spend), dormant → 503.
 */
export async function GET(req: Request) {
  if (!shieldConfigured()) {
    return NextResponse.json({ error: "privacy not yet live", code: "SHIELD_OFF" }, { status: 503 });
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const url = new URL(req.url);
  const coinType = url.searchParams.get("coinType") || USDSUI_TYPE;
  const raw = url.searchParams.get("nullifier");
  if (!raw) {
    return NextResponse.json({ error: "nullifier query param required" }, { status: 400 });
  }

  // Normalize each to a u256 decimal string; reject anything non-numeric.
  const wanted: string[] = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    try {
      wanted.push(BigInt(part).toString());
    } catch {
      return NextResponse.json(
        { error: `nullifier must be a u256 (decimal or 0x): ${part}` },
        { status: 400 }
      );
    }
  }
  if (wanted.length === 0) {
    return NextResponse.json({ error: "no nullifiers supplied" }, { status: 400 });
  }

  await ensureShieldSchema();
  const placeholders = wanted.map(() => "?").join(", ");
  const r = await db().execute({
    sql: `SELECT nullifier FROM shield_nullifiers
          WHERE coin_type = ? AND nullifier IN (${placeholders})`,
    args: [coinType, ...wanted],
  });
  const spentSet = new Set(
    (r.rows as Array<{ nullifier: string }>).map((row) => row.nullifier)
  );

  const spent: Record<string, boolean> = {};
  for (const n of wanted) spent[n] = spentSet.has(n);
  const anySpent = wanted.some((n) => spent[n]);

  return NextResponse.json({ coinType, spent, anySpent });
}
