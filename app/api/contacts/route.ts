import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { readActivitySnapshot, refreshInBackground } from "@/lib/snapshots";
import {
  computeLiveActivity,
  ACTIVITY_SNAPSHOT_BG_REFRESH_MS,
  type SerializedEntry,
} from "@/lib/activity-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/contacts — recent counterparties built from the user's
 * on-chain activity. Deduped by address, sorted by most-recent
 * interaction, capped at 30.
 *
 * Mobile uses this to populate the contacts sheet that pops over the
 * Home screen. Tapping a row deep-links into Send with the recipient
 * pre-filled.
 *
 * Fast-load policy: contacts are a pure DERIVED VIEW of the per-user
 * activity snapshot (`user_activity_snapshot`, the same monotonic floor
 * /api/activity maintains), so the request path is one indexed PK read —
 * never the 4-6s tx-history walk that used to ride here. A slightly stale
 * contact list is fine: contacts only change when the user transacts, and
 * the post-send `?fresh=1` activity reconcile updates the snapshot anyway.
 * Only a user with NO snapshot at all (brand-new, contacts before Home)
 * pays a live scan, and even then with a hard 2.5s budget — the in-flight
 * scan keeps running and write-throughs the snapshot, so it self-heals.
 */

type Contact = {
  address: string;
  name: string | null;
  lastSeenMs: number;
  sentCount: number;
  receivedCount: number;
};

/** Fold activity rows into the deduped, newest-first contact list. */
function contactsFrom(entries: SerializedEntry[]): Contact[] {
  const seen = new Map<string, Contact>();
  for (const e of entries) {
    if (!e.counterparty) continue;
    // Off-ramp deposit wallets are NOT contacts. A cash-out's on-chain
    // leg pays a Linq deposit address whose enriched counterpartyName is
    // the destination BANK ("OPay", "Moniepoint MFB", …) — surfacing
    // those as recents read like Talise thinks your bank is a person,
    // and each cash-out mints a fresh deposit address so they multiply.
    if (e.offramp) continue;
    const addr = e.counterparty.toLowerCase();
    const existing = seen.get(addr);
    if (existing) {
      existing.lastSeenMs = Math.max(existing.lastSeenMs, e.timestampMs);
      if (e.direction === "sent") existing.sentCount += 1;
      else existing.receivedCount += 1;
      if (!existing.name && e.counterpartyName) existing.name = e.counterpartyName;
    } else {
      seen.set(addr, {
        address: e.counterparty,
        name: e.counterpartyName,
        lastSeenMs: e.timestampMs,
        sentCount: e.direction === "sent" ? 1 : 0,
        receivedCount: e.direction === "received" ? 1 : 0,
      });
    }
  }
  return [...seen.values()]
    .sort((a, b) => b.lastSeenMs - a.lastSeenMs)
    .slice(0, 30);
}

export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  try {
    // Snapshot-first: ANY age serves (the floor is monotonic — it can only
    // be missing rows newer than the last refresh, never wrong ones). Warm
    // it in the background when it's older than the shared refresh window.
    const snap = await readActivitySnapshot(userId).catch(() => null);
    if (snap) {
      if (Date.now() - snap.refreshedAt > ACTIVITY_SNAPSHOT_BG_REFRESH_MS) {
        refreshInBackground(async () => {
          await computeLiveActivity(
            { id: user.id, sui_address: user.sui_address, talise_vault_id: user.talise_vault_id ?? null },
            50,
            false
          );
        });
      }
      return NextResponse.json(
        { contacts: contactsFrom(snap.entries as SerializedEntry[]) },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }

    // No snapshot yet — BOUNDED live scan. The compute write-throughs the
    // snapshot when it lands (even after we've responded), so the next load
    // is instant. 2.5s budget: past that, an empty picker beats a spinner.
    const LIVE_BUDGET_MS = 2_500;
    const livePromise = computeLiveActivity(
      { id: user.id, sui_address: user.sui_address, talise_vault_id: user.talise_vault_id ?? null },
      50,
      false
    );
    livePromise.catch(() => {}); // abandoned slow scan must not reject unhandled
    const entries = await Promise.race([
      livePromise,
      new Promise<SerializedEntry[]>((r) => setTimeout(() => r([]), LIVE_BUDGET_MS)),
    ]);
    return NextResponse.json(
      { contacts: contactsFrom(entries) },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (err) {
    console.warn(`[api/contacts] failed: ${(err as Error).message}`);
    return NextResponse.json({ contacts: [] });
  }
}
