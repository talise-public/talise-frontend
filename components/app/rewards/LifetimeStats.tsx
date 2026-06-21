"use client";

import { GlassCard, MicroLabel, useCurrency } from "@/components/app";

/**
 * Two side-by-side tiles: lifetime Sent + lifetime Saved, localized to the
 * user's display currency. The Saved tile is accent-mint so the eye reads
 * the savings side as the win (matches iOS `lifetimeStatsRow`).
 */
export function LifetimeStats({
  sentUsd,
  savedUsd,
}: {
  sentUsd: number;
  savedUsd: number;
}) {
  const { formatLocal } = useCurrency();
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <Tile label="Lifetime sent" value={formatLocal(sentUsd, { fixed: true })} />
      <Tile label="Lifetime saved" value={formatLocal(savedUsd, { fixed: true })} accent />
    </div>
  );
}

function Tile({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <GlassCard className="p-5 md:p-6" tint={accent ? "#CAFFB8" : undefined}>
      <MicroLabel>{label}</MicroLabel>
      <div
        className="mt-2 tabular-nums text-[#15300c]"
        style={{ fontSize: 22, fontWeight: 500, letterSpacing: "-0.025em", lineHeight: 1.15 }}
      >
        {value}
      </div>
    </GlassCard>
  );
}
