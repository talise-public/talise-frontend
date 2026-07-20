import "server-only";

import { getRecentActivityWithMeta, type ActivityEntry } from "@/lib/activity";

/**
 * Talise Rewards, Month Insights (Phase 3).
 *
 * Lightweight month-to-date summary derived from the activity feed.
 * No new tables; we just bucket the user's recent on-chain motion into
 * spent / received / saved totals and surface the top counterparties.
 *
 * Why over the activity feed (not the rewards_events ledger)? Because
 * rewards events only fire on Talise-originated sponsored txs; the
 * activity feed shows EVERY USDsui movement (inbound funding from
 * outside Talise, etc.). For an "insights" surface the chain-level
 * truth is the better signal.
 *
 * Buckets:
 *   - `spent`     ← direction === "sent"      (USD value of outflows)
 *   - `received`  ← direction === "received"  (USD value of inflows)
 *   - `saved`     ← direction === "invest"    (yield supplies count as savings)
 *   - withdraws are intentionally excluded, they're a wash with
 *     "saved" (money moving back to the user's own wallet).
 *
 * Top counterparties: group all sent/received entries this month by
 * `counterparty` address, sum the USD value, return the top 3 by total.
 * `counterpartyName` (resolved talise.sui handle) carried through when
 * present so the UI can render "You sent ₦15k to jude this month".
 */

export type TopCounterparty = {
  address: string;
  name: string | null;
  count: number;
  totalUsd: number;
};

export type MonthInsights = {
  spentUsd: number;
  receivedUsd: number;
  savedUsd: number;
  topCounterparties: TopCounterparty[];
  /** Epoch-ms of the start of the current calendar month (UTC). */
  monthStartMs: number;
  /** Number of activity entries that contributed (debugging aid). */
  sampleSize: number;
  /**
   * False when the underlying tx-history read timed out or failed, the
   * totals above were computed from a PARTIAL (possibly empty) view of
   * the chain and must NOT be cached or presented as truth. Same
   * integrity principle as the 2026-06-11 balances incident: a failed
   * read is never a genuine zero. The route serves the last-known-good
   * snapshot (or marks the response `partial`) when this is false.
   */
  complete: boolean;
};

/** Start-of-month UTC for a given timestamp. */
function startOfMonth(t: number = Date.now()): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
}

/**
 * Per-entry USD value. We use USDsui as a 1:1 USD proxy (it's the user's
 * stable-coin balance). When an entry only carries SUI (rare for Talise
 * txs, these are usually gas-only sponsor reimbursements), we skip it
 * rather than mis-priced its USD value here. Future: fold in suiPriceUsd.
 */
function usdValue(e: ActivityEntry): number {
  if (typeof e.amountUsdsui === "number" && e.amountUsdsui > 0) {
    return e.amountUsdsui;
  }
  return 0;
}

/**
 * Aggregate the last `sampleSize` activity entries for `address` into a
 * month-to-date insights summary. Falls back gracefully if the activity
 * fetch fails, returns zeros + an empty counterparty list, but ALWAYS
 * with `complete: false` so the caller knows these zeros came from a
 * failed read, not from a genuinely quiet month.
 */
export async function getMonthInsights(
  address: string,
  sampleSize = 50
): Promise<MonthInsights> {
  const monthStartMs = startOfMonth();
  let entries: ActivityEntry[] = [];
  let complete = true;
  try {
    const r = await getRecentActivityWithMeta(address, sampleSize, {
      includeNonTalise: true,
    });
    entries = r.entries;
    complete = r.complete;
  } catch {
    // Soft fail, the Insights section is decorative, not load-bearing.
    // `complete: false` keeps the zeros from being mistaken for truth.
    return {
      spentUsd: 0,
      receivedUsd: 0,
      savedUsd: 0,
      topCounterparties: [],
      monthStartMs,
      sampleSize: 0,
      complete: false,
    };
  }

  let spentUsd = 0;
  let receivedUsd = 0;
  let savedUsd = 0;
  const cpMap = new Map<string, TopCounterparty>();
  let contributed = 0;

  for (const e of entries) {
    if (!e.timestampMs || e.timestampMs < monthStartMs) continue;
    const usd = usdValue(e);
    if (usd <= 0) continue;
    contributed++;
    if (e.direction === "sent") spentUsd += usd;
    else if (e.direction === "received") receivedUsd += usd;
    else if (e.direction === "invest") savedUsd += usd;

    // Only sent/received contribute to counterparties, invest/withdraw
    // have no real counterparty (the pool isn't a person).
    // Skip self-sends: when a user pays their own address (rare but
    // possible via SuiNS misroute or a debugging tx), they shouldn't
    // rank themselves as their own top counterparty.
    if (
      (e.direction === "sent" || e.direction === "received") &&
      e.counterparty &&
      e.counterparty.toLowerCase() !== address.toLowerCase()
    ) {
      const existing = cpMap.get(e.counterparty);
      if (existing) {
        existing.count += 1;
        existing.totalUsd += usd;
        // Carry through the friendliest name we've seen for this address.
        if (!existing.name && e.counterpartyName) {
          existing.name = e.counterpartyName;
        }
      } else {
        cpMap.set(e.counterparty, {
          address: e.counterparty,
          name: e.counterpartyName ?? null,
          count: 1,
          totalUsd: usd,
        });
      }
    }
  }

  const topCounterparties = Array.from(cpMap.values())
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, 3);

  return {
    spentUsd,
    receivedUsd,
    savedUsd,
    topCounterparties,
    monthStartMs,
    sampleSize: contributed,
    complete,
  };
}
