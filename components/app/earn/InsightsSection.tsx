"use client";

/**
 * Month-to-date money insights: Spent / Received / Saved tiles + a short list
 * of top counterparties. Reads GET /api/rewards/insights.
 */

import { HugeiconsIcon } from "@hugeicons/react";
import { Analytics02Icon } from "@hugeicons/core-free-icons";
import { GlassCard, Eyebrow, useCurrency } from "@/components/app";
import { useInsights } from "./earn-data";

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long" });

export function InsightsSection() {
  const { data, loading } = useInsights();
  const { formatUsd } = useCurrency();

  const monthLabel = data?.monthStartMs ? MONTH.format(new Date(data.monthStartMs)) : "This month";

  // A `partial` response (server tx-history read timed out, no snapshot) or a
  // failed fetch (data still null after loading) means we DON'T KNOW the
  // totals — render "—" rather than a confident ₦0.00 that looks like truth.
  const trusted = data && !data.partial;
  const tileValue = (v: number | undefined) =>
    trusted ? formatUsd(v ?? 0, { fixed: true }) : "—";

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Eyebrow>Insights</Eyebrow>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#3d7a29]">
          · {monthLabel}
        </span>
      </div>

      {/* 3-tile stat row — compact, no large empty voids */}
      <div className="grid grid-cols-3 gap-2.5">
        <Tile label="Spent" value={tileValue(data?.spentUsd)} loading={loading && !data} />
        <Tile label="Received" value={tileValue(data?.receivedUsd)} loading={loading && !data} />
        <Tile
          label="Saved"
          value={tileValue(data?.savedUsd)}
          accent
          loading={loading && !data}
        />
      </div>

      {/* Top counterparties — Wise-style list rows */}
      {data && data.topCounterparties.length > 0 && (
        <GlassCard radius={20} className="overflow-hidden !p-0">
          {data.topCounterparties.slice(0, 4).map((c, i) => (
            <div key={c.address}>
              {i > 0 && <div className="mx-4 h-px bg-[#15300c]/10" />}
              <div className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#CAFFB8] font-mono text-[11px] font-medium text-[#15300c]">
                  {initials(c.name, c.address)}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-[#15300c]">
                    {c.name ?? shortAddr(c.address)}
                  </span>
                  <span className="block font-mono text-[11px] text-[#3d7a29]">
                    {c.count} {c.count === 1 ? "payment" : "payments"}
                  </span>
                </div>
                <span className="text-[13px] font-medium tabular-nums text-[#15300c]">
                  {formatUsd(c.totalUsd, { fixed: true })}
                </span>
              </div>
            </div>
          ))}
        </GlassCard>
      )}

      {/* Empty state only when the data is trustworthy — a partial read's
          empty list doesn't mean the user hasn't sent anything. */}
      {trusted && data.topCounterparties.length === 0 && !loading && (
        <GlassCard radius={20} className="flex items-center gap-3 px-4 py-3.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#CAFFB8] text-[#15300c]">
            <HugeiconsIcon icon={Analytics02Icon} size={17} strokeWidth={1.6} />
          </span>
          <p className="text-[12px] text-[#3a5230]">
            Your spending breakdown shows up here once you start sending.
          </p>
        </GlassCard>
      )}
    </section>
  );
}

function Tile({
  label,
  value,
  accent,
  loading,
}: {
  label: string;
  value: string;
  accent?: boolean;
  loading?: boolean;
}) {
  return (
    // min-w-0: grid items default to min-width:auto and refuse to shrink below
    // their content, which let long formatted amounts push this 3-up row wider
    // than the phone viewport (horizontal page scroll). min-w-0 lets the tile
    // shrink so the truncate below actually engages.
    <GlassCard radius={18} className="min-w-0 px-3 py-3">
      <span className="block truncate font-mono text-[10px] uppercase tracking-[0.16em] text-[#3d7a29]">
        {label}
      </span>
      {loading ? (
        <span className="mt-2 block h-4 w-10 rounded-full bg-[#15300c]/10" />
      ) : (
        <span
          className={`mt-1 block truncate text-[15px] font-medium tracking-[-0.02em] tabular-nums ${
            accent ? "text-[#3d7a29]" : "text-[#15300c]"
          }`}
        >
          {value}
        </span>
      )}
    </GlassCard>
  );
}

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function initials(name: string | null, address: string): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || name[0].toUpperCase();
  }
  return address.slice(2, 4).toUpperCase();
}
