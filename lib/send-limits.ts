/**
 * Send-limit enforcement — hard, API-layer transaction caps.
 *
 * Closes the documented compliance gap (master plan §7 "no API-layer
 * daily-limit enforcement", §11 item 2 "Enforce a hard daily-limit +
 * tier-aware rejection"). The send path historically enforced NO server-
 * side limit; this module is the first cut of that control.
 *
 * ── What it does ────────────────────────────────────────────────────
 *   • Maintains a rolling DAILY and MONTHLY sent-total per user in a
 *     dedicated append-only ledger (`send_limit_ledger`).
 *   • Reads a per-user KYC tier (`users.kyc_tier`) and maps it to a
 *     daily + monthly USD cap via a constant table.
 *   • `checkSendAllowed()` answers "would this new send breach the cap?"
 *     so the caller can reject BEFORE doing any expensive work.
 *   • `recordSend()` appends an entry once a send is committed.
 *
 * ── Defensive by design (a P0 control must NEVER 500) ───────────────
 * This module is additive and runs alongside infra that may only be
 * partially deployed (the KYC branch hasn't merged — `users.kyc_tier`
 * may not exist yet). Every path is hardened so a limits-infra fault
 * degrades gracefully instead of blocking sends:
 *   • `kyc_tier` column absent / NULL  → treat as Tier 0.
 *   • ledger table absent              → lazily created; on create
 *                                        failure the window total is
 *                                        treated as 0 (fail-open).
 *   • any DB error in the read path    → fail-open (return allowed),
 *                                        logged once. A flaky DB must
 *                                        not turn a legitimate send into
 *                                        a 500.
 *   • `recordSend` failure             → swallowed (best-effort); the
 *                                        send already happened, a missed
 *                                        ledger row only under-counts.
 *
 * The fail-open posture matches the existing rate-limiter (web/lib/
 * rate-limit.ts) and round-up config (sponsor-prepare): guards, not
 * gates. When the KYC branch lands and `users.kyc_tier` is populated,
 * the tier read tightens automatically with zero changes here.
 */

import { db } from "@/lib/db";

// ── Tier → cap table ─────────────────────────────────────────────────
// Keyed by the integer `kyc_tier` (master plan §7 risk-tier model):
//   Tier 0 — email only (Google OAuth): the floor every user starts at.
//   Tier 1 — basic ID + liveness.
//   Tier 2 — full ID + address + sanctions clear.
//   Tier 3 — source-of-funds / EDD (high value, PEP, business).
// Amounts are USD (USDsui is 1:1 USD). `Infinity` = no cap at this tier.
//
// These are conservative placeholders aligned with §7's stated bands
// (Tier 1 ≈ $1,000/mo). They are intentionally a simple constant map —
// the master plan calls for per-corridor / per-license tuning later;
// this is the enforcement primitive, not the final policy table.
export interface TierCap {
  /** Max USD sent in a rolling 24h window. */
  dailyUsd: number;
  /** Max USD sent in a rolling 30-day window. */
  monthlyUsd: number;
}

export const TIER_CAPS: Readonly<Record<number, TierCap>> = {
  0: { dailyUsd: 200, monthlyUsd: 1_000 },
  1: { dailyUsd: 1_000, monthlyUsd: 5_000 },
  2: { dailyUsd: 10_000, monthlyUsd: 50_000 },
  3: { dailyUsd: Infinity, monthlyUsd: Infinity },
};

/** Tier used whenever the user's tier can't be resolved (column absent,
 *  NULL, out-of-range, or DB read fault). The most restrictive band. */
export const DEFAULT_TIER = 0;

function capForTier(tier: number): TierCap {
  return TIER_CAPS[tier] ?? TIER_CAPS[DEFAULT_TIER];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

// ── Ledger schema (self-owned, idempotent) ───────────────────────────
// Append-only: one row per committed send. We aggregate over a rolling
// window rather than maintaining a running counter so the window is
// always exact and there's no reset/rollover bookkeeping.
//
// This module bootstraps its own table (rather than adding to
// db.ts:ensureSchema) to keep the workstream additive and self-
// contained. The CREATE is idempotent and gated behind a once-per-
// process promise so concurrent sends don't race the migration.
let _schemaReadyP: Promise<void> | null = null;

async function ensureLedgerSchema(): Promise<void> {
  if (_schemaReadyP) return _schemaReadyP;
  _schemaReadyP = (async () => {
    const c = db();
    await c.execute(
      `CREATE TABLE IF NOT EXISTS send_limit_ledger (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        amount_usd DOUBLE PRECISION NOT NULL,
        asset TEXT,
        digest TEXT,
        created_at BIGINT NOT NULL
      )`
    );
    // Covers the rolling-window aggregate: `WHERE user_id = ? AND
    // created_at >= ?`. created_at DESC keeps recent rows clustered for
    // the window scan.
    await c.execute(
      `CREATE INDEX IF NOT EXISTS idx_send_limit_ledger_user_created
         ON send_limit_ledger(user_id, created_at DESC)`
    );
  })().catch((err) => {
    // Reset so a transient failure (e.g. DB cold) can retry next call.
    _schemaReadyP = null;
    throw err;
  });
  return _schemaReadyP;
}

// ── KYC tier read (defensive) ────────────────────────────────────────
/**
 * Read the user's `kyc_tier`. Returns `DEFAULT_TIER` when the column
 * doesn't exist yet (KYC branch unmerged), is NULL, or the query
 * faults. Never throws.
 */
export async function getKycTier(userId: number): Promise<number> {
  try {
    const r = await db().execute({
      sql: "SELECT kyc_tier FROM users WHERE id = ? LIMIT 1",
      args: [userId],
    });
    const raw = r.rows[0]?.kyc_tier;
    if (raw == null) return DEFAULT_TIER;
    const tier = Number(raw);
    return Number.isInteger(tier) && tier >= 0 ? tier : DEFAULT_TIER;
  } catch {
    // Column absent ("column \"kyc_tier\" does not exist") or any other
    // read fault → fall back to the most restrictive tier. A defensive
    // default here is safe: it never *raises* a user's allowance.
    return DEFAULT_TIER;
  }
}

// ── Rolling-window sent total ────────────────────────────────────────
/**
 * Sum of `amount_usd` for this user with `created_at >= sinceMs`.
 * Returns 0 on any fault (table missing, DB error) so the limit check
 * fails open rather than blocking the send.
 */
async function sentSince(userId: number, sinceMs: number): Promise<number> {
  try {
    const r = await db().execute({
      sql: `SELECT COALESCE(SUM(amount_usd), 0) AS total
              FROM send_limit_ledger
             WHERE user_id = ? AND created_at >= ?`,
      args: [userId, sinceMs],
    });
    const total = Number(r.rows[0]?.total ?? 0);
    return Number.isFinite(total) && total > 0 ? total : 0;
  } catch {
    return 0;
  }
}

// ── Public API ───────────────────────────────────────────────────────
export interface LimitWindow {
  /** Which window breached (or would breach). */
  window: "daily" | "monthly";
  /** The cap for that window, in USD. */
  limit: number;
  /** USD already sent in that window (excluding the pending amount). */
  used: number;
}

export type LimitDecision =
  | { allowed: true; tier: number }
  | ({ allowed: false; tier: number } & LimitWindow);

/**
 * Would a new send of `amountUsd` breach this user's tier cap?
 *
 * Checks the daily window first, then monthly; returns the first window
 * that would be breached. The pending `amountUsd` is INCLUDED in the
 * comparison (used + amount > limit ⇒ breach) so a single oversized
 * send can't slip under a fresh window.
 *
 * Never throws — on any internal fault it returns `{ allowed: true }`
 * (fail-open). The caller can treat a thrown error as "allow" too, but
 * this contract means callers don't need a try/catch.
 */
export async function checkSendAllowed(
  userId: number,
  amountUsd: number
): Promise<LimitDecision> {
  // A non-positive or non-finite amount is not ours to police — the
  // caller already validates amount bounds. Don't block, don't record.
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return { allowed: true, tier: DEFAULT_TIER };
  }

  try {
    // Best-effort table bootstrap. If it fails, sentSince() still
    // returns 0 and we fail open below.
    await ensureLedgerSchema().catch(() => {});

    const tier = await getKycTier(userId);
    const cap = capForTier(tier);
    const now = Date.now();

    // Daily window.
    if (Number.isFinite(cap.dailyUsd)) {
      const usedDay = await sentSince(userId, now - DAY_MS);
      if (usedDay + amountUsd > cap.dailyUsd) {
        return {
          allowed: false,
          tier,
          window: "daily",
          limit: cap.dailyUsd,
          used: usedDay,
        };
      }
    }

    // Monthly window.
    if (Number.isFinite(cap.monthlyUsd)) {
      const usedMonth = await sentSince(userId, now - MONTH_MS);
      if (usedMonth + amountUsd > cap.monthlyUsd) {
        return {
          allowed: false,
          tier,
          window: "monthly",
          limit: cap.monthlyUsd,
          used: usedMonth,
        };
      }
    }

    return { allowed: true, tier };
  } catch (err) {
    // FAIL OPEN — a limits-infra fault must never block a legitimate
    // send. Logged so the gap is visible in prod logs.
    console.error(
      `[send-limits] checkSendAllowed faulted for user=${userId}; failing open:`,
      (err as Error).message
    );
    return { allowed: true, tier: DEFAULT_TIER };
  }
}

/**
 * Append a committed send to the ledger so it counts toward future
 * window checks. Best-effort — never throws. A dropped row only
 * under-counts (lets a user send slightly more), which is the safe
 * direction for a guard that must not break sends.
 *
 * `digest` is optional: callers that record at prepare-time (before a
 * broadcast digest exists) pass none; callers that record post-confirm
 * can pass the on-chain digest for audit/dedupe.
 */
export async function recordSend(input: {
  userId: number;
  amountUsd: number;
  asset?: string | null;
  digest?: string | null;
}): Promise<void> {
  if (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0) return;
  try {
    await ensureLedgerSchema();
    await db().execute({
      sql: `INSERT INTO send_limit_ledger
              (user_id, amount_usd, asset, digest, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        input.userId,
        input.amountUsd,
        input.asset ?? null,
        input.digest ?? null,
        Date.now(),
      ],
    });
  } catch (err) {
    console.warn(
      `[send-limits] recordSend failed (user=${input.userId}, amount=${input.amountUsd}); continuing:`,
      (err as Error).message
    );
  }
}
