import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { getMonthInsights } from "@/lib/rewards/insights";
import { memoTtl, invalidate } from "@/lib/perf-cache";
import {
  readInsightsSnapshot,
  writeInsightsSnapshot,
  refreshInBackground,
} from "@/lib/snapshots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/rewards/insights — month-to-date spending/saving summary for
 * the authenticated user, derived from getRecentActivity(). Used by the
 * iOS Rewards tab's Insights section.
 *
 * Response shape mirrors `MonthInsights` Codable in APIModels.swift, plus
 * additive { partial, stale, refreshedAt, source } the client may ignore.
 *
 * Integrity (2026-06-11 incident principle — a failed read is never a
 * genuine zero): when the underlying tx-history walk timed out, the
 * computed zeros are NOT truth. We (1) drop them from the 60s memo so one
 * timeout can't poison the next minute of requests, (2) serve the
 * last-known-good per-user snapshot for the same month instead, and
 * (3) only when there is no snapshot at all, return the zeros explicitly
 * marked `partial: true` so clients render "—" instead of ₦0.00.
 */
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
    // Insights derive from a tx-history walk (the slow leg). They don't change
    // second-to-second, so cache per-address for 60s — the first load pays the
    // walk, repeat loads (Rewards tab re-mounts, tab churn) are instant.
    const cacheKey = `insights:${user.sui_address}`;
    const insights = await memoTtl(cacheKey, 60_000, () =>
      getMonthInsights(user.sui_address, 50)
    );
    const payload = {
      spentUsd: insights.spentUsd,
      receivedUsd: insights.receivedUsd,
      savedUsd: insights.savedUsd,
      monthStartMs: insights.monthStartMs,
      sampleSize: insights.sampleSize,
      topCounterparties: insights.topCounterparties.map((c) => ({
        address: c.address,
        name: c.name,
        count: c.count,
        totalUsd: c.totalUsd,
      })),
    };

    if (insights.complete) {
      // Write-through (after the response flushes): this complete read
      // becomes the last-known-good value the timeout path below serves.
      refreshInBackground(() =>
        writeInsightsSnapshot({
          userId,
          address: user.sui_address,
          insights: payload,
        })
      );
      return NextResponse.json({ ...payload, partial: false });
    }

    // INCOMPLETE read — the tx-history walk timed out or failed and the
    // zeros in `payload` are fabricated. Never let the memo serve them for
    // the next 60s (one timeout must not poison subsequent requests).
    invalidate(cacheKey);

    // Serve the last-known-good snapshot — but only for the SAME month;
    // a value from a prior month would replay stale month-to-date totals.
    const snap = await readInsightsSnapshot(userId);
    const known = snap?.insights as typeof payload | null | undefined;
    if (known && known.monthStartMs === payload.monthStartMs) {
      return NextResponse.json({
        ...known,
        partial: false,
        stale: true,
        refreshedAt: snap!.refreshedAt,
        source: "snapshot",
      });
    }

    // Nothing better exists (brand-new user / first month / snapshot table
    // empty) — return the zeros explicitly marked partial so clients keep
    // their last-known value or render "—" instead of a confident ₦0.00.
    return NextResponse.json({ ...payload, partial: true });
  } catch (err) {
    console.warn(
      `[rewards/insights] user=${userId} failed: ${(err as Error).message}`
    );
    return NextResponse.json(
      { error: "could not load insights" },
      { status: 500 }
    );
  }
}
