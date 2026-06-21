import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { denyUnlessAppApproved } from "@/lib/app-access";

export const runtime = "nodejs";

/**
 * Shield note-master ESCROW — the OAuth-bound recovery rail (Workstream D).
 *
 * The note master is the root of a user's shielded notes. The PRIMARY copy
 * lives on-device (iCloud-synchronizable Keychain); this endpoint is the
 * RECOVERY rail so a user who reinstalls / switches devices can restore it by
 * signing back in (it's keyed to their stable Talise account id). Combined with
 * the keychain, a user recovers by: re-sign-in → restore master → re-scan.
 *
 * PILOT TRUST NOTE: the master is stored keyed to the account id (operator-
 * readable) — consistent with the operator-trusted pilot posture. The
 * non-custodial hardening (client-side wrap under a passkey/recovery-code so the
 * server can't read it) is a fast-follow; documented in PRIVACY-BUILD-PLAN.md.
 */

let _escrowReady: Promise<void> | null = null;
async function ensureEscrowTable(): Promise<void> {
  if (_escrowReady) return _escrowReady;
  _escrowReady = (async () => {
    await ensureSchema();
    await db().execute(
      `CREATE TABLE IF NOT EXISTS shield_key_escrow (
         user_id TEXT PRIMARY KEY,
         note_master TEXT NOT NULL,
         created_at BIGINT NOT NULL,
         updated_at BIGINT NOT NULL
       )`
    );
  })();
  return _escrowReady;
}

/** GET → restore: `{ noteMaster: string | null }`. */
export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;

  await ensureEscrowTable();
  const r = await db().execute({
    sql: `SELECT note_master FROM shield_key_escrow WHERE user_id = ?`,
    args: [String(userId)],
  });
  const noteMaster = (r.rows[0]?.note_master as string | undefined) ?? null;
  return NextResponse.json({ noteMaster });
}

/** POST { noteMaster } → backup. First-writer-wins: never overwrite an existing
 *  master (the on-device copy is authoritative; a clobber would orphan notes). */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;

  let body: { noteMaster?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const noteMaster = String(body.noteMaster ?? "").trim();
  // 32 bytes hex = 64 chars; accept 32–128 hex chars for forward-compat.
  if (!/^[0-9a-f]{32,128}$/i.test(noteMaster)) {
    return NextResponse.json({ error: "noteMaster must be hex (32–128 chars)" }, { status: 400 });
  }

  await ensureEscrowTable();
  const now = Date.now();
  // INSERT … ON CONFLICT DO NOTHING — first write wins, so a re-derived or
  // re-generated master can never overwrite the recovery copy.
  await db().execute({
    sql: `INSERT INTO shield_key_escrow (user_id, note_master, created_at, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (user_id) DO NOTHING`,
    args: [String(userId), noteMaster, now, now],
  });
  // Echo back the authoritative stored master so the client adopts the escrow
  // copy if one already existed (prevents two devices diverging on first use).
  const r = await db().execute({
    sql: `SELECT note_master FROM shield_key_escrow WHERE user_id = ?`,
    args: [String(userId)],
  });
  return NextResponse.json({ noteMaster: (r.rows[0]?.note_master as string | undefined) ?? noteMaster });
}
