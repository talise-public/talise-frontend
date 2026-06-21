"use client";

/**
 * Recent activity preview — the top 5 entries from useActivity rendered as
 * compact glass rows (direction disc, title + counterparty, relative time, and
 * a signed localized amount). "View all" routes to the full Activity page.
 *
 * useActivity already listens for the global `talise:tx` event and re-pulls
 * fresh, so a send/receive made elsewhere in the app reflects here without a
 * manual refresh. We keep prior rows visible during a refresh (no skeleton
 * flash) once we've loaded at least once — same UX as iOS.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUpRight01Icon,
  ArrowDownLeft01Icon,
  Invoice01Icon,
  BankIcon,
} from "@hugeicons/core-free-icons";
import {
  useActivity,
  useCurrency,
  useHiddenAmounts,
  MASK_AMOUNT,
  GlassCard,
  Eyebrow,
  EmptyState,
  type ActivityEntry,
} from "@/components/app";
import {
  offrampState,
  offrampChipLabel,
  offrampBankLine,
  formatNgn,
} from "../activity/types";
import { relativeTime } from "./relativeTime";

function counterpartyLabel(e: ActivityEntry): string {
  if (e.counterpartyName) return e.counterpartyName;
  if (e.venue) return e.venue === "navi" ? "NAVI · Earn" : "DeepBook · Earn";
  const a = e.counterparty;
  if (a && a.startsWith("0x") && a.length > 14) return `${a.slice(0, 8)}…${a.slice(-4)}`;
  return a || "On-chain";
}

function titleFor(e: ActivityEntry): string {
  if (e.venue) return e.direction === "sent" ? "Moved to Earn" : "Earn payout";
  return e.direction === "received" ? "Received" : "Sent";
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const { formatLocal } = useCurrency();
  const { hidden } = useHiddenAmounts();

  // Cash-out (USDsui→NGN bank off-ramp) renders distinctly: bank glyph, NGN
  // payout in the danger tone, and a status chip while it's settling.
  if (entry.offramp) {
    const o = entry.offramp;
    const bank = o.bankName?.trim();
    const chip =
      offrampState(o.status) === "done" ? null : offrampChipLabel(o.status);
    return (
      <div
        className="flex items-center gap-3.5 rounded-[16px] border border-[#15300c]/10 bg-white/60 px-3.5 py-3 backdrop-blur-sm transition-colors hover:border-[#15300c]/20"
        data-direction="sent"
      >
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-full"
          style={{ background: "color-mix(in srgb, #c0532f 16%, #f7fcf2)" }}
        >
          <HugeiconsIcon icon={BankIcon} size={17} strokeWidth={2} color="#c0532f" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium text-[#15300c]">
            {bank ? `Cash out → ${bank}` : "Cash out"}
          </span>
          <span className="block truncate text-[12px] text-[#3d7a29]">
            {offrampBankLine(o)}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          <span
            className="text-[14px] font-semibold tabular-nums"
            style={{ color: "#c0532f" }}
          >
            −{hidden ? MASK_AMOUNT : formatNgn(o.amountNgn)}
          </span>
          {chip ? (
            <span
              className="rounded-full px-1.5 py-px text-[10px] font-medium"
              style={
                offrampState(o.status) === "failed"
                  ? {
                      color: "#c0532f",
                      background: "color-mix(in srgb, #c0532f 12%, transparent)",
                    }
                  : { color: "#3a5230", background: "rgba(21,48,12,0.06)" }
              }
            >
              {chip}
            </span>
          ) : (
            <span className="mt-0.5 font-mono text-[10px] text-[#3d7a29]">
              {relativeTime(entry.timestampMs)}
            </span>
          )}
        </span>
      </div>
    );
  }

  const received = entry.direction === "received";
  const amt = formatLocal(entry.amountUsdsui, { fixed: true });
  const signed = `${received ? "+" : "−"}${hidden ? MASK_AMOUNT : amt}`;

  return (
    <div
      className="flex items-center gap-3.5 rounded-[16px] border border-[#15300c]/10 bg-white/60 px-3.5 py-3 backdrop-blur-sm transition-colors hover:border-[#15300c]/20"
      data-direction={entry.direction}
    >
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-full"
        style={{ background: received ? "#CAFFB8" : "rgba(21,48,12,0.06)" }}
      >
        <HugeiconsIcon
          icon={received ? ArrowDownLeft01Icon : ArrowUpRight01Icon}
          size={17}
          strokeWidth={2}
          color={received ? "#3d7a29" : "#15300c"}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-[#15300c]">{titleFor(entry)}</span>
        <span className="block truncate text-[12px] text-[#3d7a29]">{counterpartyLabel(entry)}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end">
        <span
          className="text-[14px] font-semibold tabular-nums"
          style={{ color: received ? "#3d7a29" : "#15300c" }}
        >
          {signed}
        </span>
        <span className="mt-0.5 font-mono text-[10px] text-[#3d7a29]">
          {relativeTime(entry.timestampMs)}
        </span>
      </span>
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="flex items-center gap-3.5 rounded-[16px] border border-[#15300c]/10 bg-white/60 px-3.5 py-3 backdrop-blur-sm">
      <span className="size-9 shrink-0 animate-pulse rounded-full bg-[#15300c]/10" />
      <span className="min-w-0 flex-1 space-y-2">
        <span className="block h-2.5 w-24 animate-pulse rounded-full bg-[#15300c]/10" />
        <span className="block h-2 w-16 animate-pulse rounded-full bg-[#15300c]/[0.07]" />
      </span>
      <span className="h-3 w-14 animate-pulse rounded-full bg-[#15300c]/10" />
    </div>
  );
}

export function RecentActivity() {
  const { entries, loading, error, refresh } = useActivity(6);
  const loadedOnce = useRef(false);
  // Re-render once on tick so relative timestamps ("5m") stay roughly fresh
  // while the user lingers on Home.
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  if (entries.length > 0) loadedOnce.current = true;
  const showSkeleton = loading && !loadedOnce.current;
  const top = entries.slice(0, 6);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <Eyebrow>Recent</Eyebrow>
        {top.length > 0 && (
          <Link
            href="/app/activity"
            className="inline-flex items-center gap-1 text-[12px] text-[#3a5230] transition-colors hover:text-[#15300c]"
          >
            View all
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2.2} />
          </Link>
        )}
      </div>

      {showSkeleton ? (
        <div className="space-y-2.5">
          <RowSkeleton />
          <RowSkeleton />
          <RowSkeleton />
        </div>
      ) : error && top.length === 0 ? (
        <GlassCard className="flex items-center justify-between gap-3 px-6 py-5">
          <span className="text-[13px] text-[#3a5230]">Couldn&apos;t load activity.</span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-full border-2 border-[#15300c] px-3 py-1.5 text-[12px] font-semibold text-[#15300c] transition-colors hover:bg-[#15300c] hover:text-[#f7fcf2]"
          >
            Retry
          </button>
        </GlassCard>
      ) : top.length === 0 ? (
        <GlassCard className="px-6 py-4">
          <EmptyState
            icon={
              <HugeiconsIcon
                icon={Invoice01Icon}
                size={24}
                strokeWidth={1.8}
                color="#3d7a29"
              />
            }
            title="Nothing yet"
            subtitle="Your sends and receives will land here."
          />
        </GlassCard>
      ) : (
        <div className="space-y-2.5">
          {top.map((e) => (
            <ActivityRow
              key={
                e.digest && e.digest.length > 0
                  ? e.digest
                  : `${e.direction}:${e.timestampMs}:${e.amountUsdsui ?? ""}`
              }
              entry={e}
            />
          ))}
        </div>
      )}
    </section>
  );
}
