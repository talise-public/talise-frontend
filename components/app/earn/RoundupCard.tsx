"use client";

/**
 * Round-up & Save. A toggle + a 1–10% slider that controls how much of each
 * send gets auto-saved on settlement, plus the running "saved via round-up"
 * tally. Reads/writes GET/POST /api/rewards/roundup.
 */

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PiggyBankIcon } from "@hugeicons/core-free-icons";
import { GlassCard, Eyebrow, useCurrency, useToast, ApiError } from "@/components/app";
import { useRoundup } from "./earn-data";

export function RoundupCard() {
  const { config, loading, update } = useRoundup();
  const { formatUsd } = useCurrency();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const enabled = config?.enabled ?? false;
  const percentage = config?.percentage ?? 5;
  const savedUsd = config?.savedUsd ?? 0;

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      const next = await update({ enabled: !enabled });
      toast(next.enabled ? "Round-up on" : "Round-up off", "neutral");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't update round-up", "danger");
    } finally {
      setBusy(false);
    }
  }

  async function setPercentage(p: number) {
    if (busy) return;
    setBusy(true);
    try {
      await update({ percentage: p });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't update round-up", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <GlassCard className="space-y-4 p-5" radius={28}>
      {/* Header row: icon + title + toggle */}
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#CAFFB8] text-[#15300c]">
          <HugeiconsIcon icon={PiggyBankIcon} size={17} strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold tracking-[-0.01em] text-[#15300c]">Round-up &amp; Save</p>
          <p className="text-[12px] text-[#3a5230]">
            Set aside a slice of every payment, automatically.
          </p>
        </div>
        <Switch on={enabled} onClick={toggle} disabled={loading || busy} />
      </div>

      {enabled && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Eyebrow>Save per payment</Eyebrow>
            <span className="text-[14px] font-medium tabular-nums text-[#3d7a29]">
              {percentage}%
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={percentage}
            disabled={busy}
            onChange={(e) => setPercentage(Number(e.target.value))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full disabled:opacity-50"
            style={{
              accentColor: "#3d7a29",
              background: `linear-gradient(to right, #3d7a29 ${((percentage - 1) / 9) * 100}%, rgba(21,48,12,0.10) ${((percentage - 1) / 9) * 100}%)`,
            }}
            aria-label="Round-up percentage"
          />
        </div>
      )}

      {/* Saved tally — mint chip */}
      <div className="flex items-center justify-between rounded-xl bg-[#CAFFB8] px-3.5 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#3d7a29]">
          Saved via round-up
        </span>
        <span className="text-[16px] font-medium tracking-[-0.02em] tabular-nums text-[#15300c]">
          {formatUsd(savedUsd, { fixed: true })}
        </span>
      </div>
    </GlassCard>
  );
}

function Switch({
  on,
  onClick,
  disabled,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-50"
      style={{
        background: on ? "#3d7a29" : "rgba(255,255,255,0.6)",
        boxShadow: on ? "none" : "inset 0 0 0 1px rgba(21,48,12,0.15)",
      }}
    >
      <span
        className="inline-block size-5 transform rounded-full bg-white transition-transform duration-200"
        style={{
          transform: on ? "translateX(22px)" : "translateX(2px)",
          boxShadow: "0 2px 6px -2px rgba(21,48,12,0.45)",
        }}
      />
    </button>
  );
}
