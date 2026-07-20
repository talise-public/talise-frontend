"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  ChampionIcon,
  Medal01Icon,
  Award01Icon,
  CrownIcon,
} from "@hugeicons/core-free-icons";
import { GlassCard, Eyebrow } from "@/components/app";
import type { ReferralTier } from "./types";

/** Tier id → glyph. Bronze climbs to a crown at Platinum. */
const TIER_ICON: Record<string, typeof Award01Icon> = {
  bronze: Award01Icon,
  silver: Medal01Icon,
  gold: ChampionIcon,
  plat: CrownIcon,
};

/**
 * The hero of the Rewards screen: tier eyebrow, a big ink points number,
 * and a progress bar to the next tier. At the top tier the bar is replaced
 * by a "Top tier" line. Mirrors the iOS `tierCard`, number is the hero,
 * no competing rosette.
 */
export function TierCard({
  tier,
  points,
}: {
  tier: ReferralTier | null;
  points: number;
}) {
  const label = (tier?.label ?? "Bronze").toUpperCase();
  const icon = TIER_ICON[tier?.id ?? "bronze"] ?? Award01Icon;
  const toNext = tier?.pointsToNext ?? null;
  const nextLabel = tier?.nextLabel ?? null;
  const hasNext = !!nextLabel && !!toNext && toNext > 0;
  const total = hasNext ? points + (toNext as number) : points;
  // Min 4% fill so a brand-new account doesn't read as an empty rail.
  const pct = hasNext && total > 0 ? Math.max(4, (points / total) * 100) : 0;

  return (
    <GlassCard className="p-7 md:p-9">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Eyebrow>{label}</Eyebrow>
          {/* Big ink number, hero stat */}
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span
              className="tabular-nums text-[#15300c]"
              style={{
                fontSize: 46,
                fontWeight: 600,
                letterSpacing: "-0.05em",
                lineHeight: 1,
              }}
            >
              {points.toLocaleString()}
            </span>
            <span className="text-[13px] text-[#3d7a29]">pts</span>
          </div>
        </div>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#CAFFB8] text-[#15300c]">
          <HugeiconsIcon icon={icon} size={20} strokeWidth={1.8} />
        </span>
      </div>

      {hasNext ? (
        <div className="mt-5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-[#3a5230]">
              {(toNext as number).toLocaleString()} to {nextLabel}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-[#3d7a29]">
              {points.toLocaleString()} / {total.toLocaleString()}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#15300c]/10">
            <div
              className="h-full rounded-full bg-[#3d7a29] transition-[width] duration-500 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      ) : tier ? (
        <p className="mt-4 font-mono text-[11px] text-[#3d7a29]">
          Top tier, every point still counts toward perks
        </p>
      ) : null}
    </GlassCard>
  );
}
