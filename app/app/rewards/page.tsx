"use client";

import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Coins01Icon } from "@hugeicons/core-free-icons";
import {
  BackButton,
  EmptyState,
  PrimaryButton,
  api,
  ApiError,
} from "@/components/app";
import {
  TierCard,
  ReferralCard,
  Redemptions,
  EarningHistory,
  type ReferralSummary,
  type Catalogue,
} from "@/components/app/rewards";

/**
 * /app/rewards — the points hub. Web counterpart of the iOS Rewards page.
 *
 * Structure mirrors iOS (2026-06 points-hub refresh):
 *   1. HERO — points balance + tier progress (TierCard).
 *   2. REFERRAL — code, copy, share.
 *   3. REDEMPTIONS — the perk catalogue.
 *   4. EARNING HISTORY — 5 most recent point events + "See all".
 * ("How you earn" rate rules deliberately omitted, matching iOS — the
 * page stays action-first.)
 *
 * Two live reads:
 *   GET /api/referral/summary   → points, tier, code, recent events
 *   GET /api/rewards/catalogue  → redeemable perks + affordability
 */
export default function RewardsPage() {
  const [summary, setSummary] = useState<ReferralSummary | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      const [s, c] = await Promise.all([
        api<ReferralSummary>("/api/referral/summary", { signal }),
        api<Catalogue>("/api/rewards/catalogue", { signal }),
      ]);
      setSummary(s);
      setCatalogue(c);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setError(
        err instanceof ApiError
          ? err.message
          : "We couldn't load your rewards. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // Refresh after a redemption: points + catalogue affordability both change.
  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <BackButton href="/app/earn" />

      {/* Page header */}
      <header className="space-y-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
          Rewards
        </p>
        <h1
          className="text-[clamp(26px,5vw,32px)] font-[800] uppercase leading-[1.0] tracking-[-0.02em] text-[#15300c]"
          style={{ fontFamily: "var(--font-display-v2)" }}
        >
          Points &amp; perks
        </h1>
        <p className="text-[14px] leading-[1.55] text-[#3a5230]">
          Earn points on every payment, invite friends, redeem perks.
        </p>
      </header>

      {loading ? (
        <RewardsSkeleton />
      ) : error ? (
        <div
          className="rounded-[28px] bg-[#f7fcf2] p-2"
          style={{ boxShadow: "10px 10px 0 #15300c" }}
        >
          <EmptyState
            icon={<HugeiconsIcon icon={Coins01Icon} size={24} strokeWidth={1.6} />}
            title="Rewards are taking a break"
            subtitle={error}
            action={<PrimaryButton onClick={refresh}>Try again</PrimaryButton>}
          />
        </div>
      ) : summary ? (
        <>
          {/* 1. Points balance + tier progress */}
          <TierCard tier={summary.tier} points={summary.pointsTotal} />

          {/* 2. Referral — the one big action */}
          <ReferralCard code={summary.code} referralCount={summary.referralCount} />

          {/* 3. Redemption catalogue */}
          <Redemptions
            items={catalogue?.items ?? []}
            pointsTotal={catalogue?.pointsTotal ?? summary.pointsTotal}
            onRedeemed={refresh}
          />

          {/* 4. Earning history — 5 most recent + "See all" */}
          <EarningHistory events={summary.recentEvents} />
        </>
      ) : null}
    </div>
  );
}

/** Flat placeholders matching the loaded layout, so the page doesn't jump. */
function RewardsSkeleton() {
  const card = "rounded-[28px] bg-[#f7fcf2]";
  const shadow = { boxShadow: "10px 10px 0 #15300c" } as const;
  const bar = "animate-pulse rounded-full bg-[#15300c]/10";
  return (
    <div className="space-y-6">
      {/* TierCard skeleton */}
      <div className={`${card} p-7`} style={shadow}>
        <div className={`h-2.5 w-16 ${bar}`} />
        <div className={`mt-3 h-10 w-36 rounded-lg ${bar}`} />
        <div className={`mt-5 h-1.5 w-full ${bar}`} />
      </div>
      {/* ReferralCard skeleton */}
      <div className={`${card} space-y-4 p-7`} style={shadow}>
        <div className={`h-2.5 w-24 ${bar}`} />
        <div className={`h-11 w-full rounded-xl ${bar}`} />
        <div className={`h-10 w-full rounded-xl ${bar}`} />
      </div>
      {/* History skeleton */}
      <div className={`${card} overflow-hidden`} style={shadow}>
        {[0, 1, 2].map((i) => (
          <div key={i}>
            {i > 0 && <div className="mx-4 h-px bg-[#15300c]/10" />}
            <div className="flex items-center gap-3 px-4 py-3">
              <div className={`h-3 w-28 flex-1 ${bar}`} />
              <div className={`h-3 w-10 ${bar}`} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
