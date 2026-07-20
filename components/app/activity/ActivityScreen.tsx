"use client";

import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { InboxIcon } from "@hugeicons/core-free-icons";
import { useActivity, Eyebrow, EmptyState, GlassCard, PrimaryButton } from "@/components/app";
import { HistoryRow } from "./HistoryRow";
import { ReceiptSheet } from "./ReceiptSheet";
import {
  type ActivityRow,
  type FilterKey,
  FILTERS,
  asRow,
  matchesFilter,
} from "./types";

/**
 * Full transaction history. Header + five filter chips (All / Sent / Received
 * / Earn / Swap), then the live feed from `useActivity(50)` rendered as
 * borderless hover-fill rows (Wise-style). Tapping a row opens the receipt
 * sheet.
 *
 * `useActivity` auto-refreshes on the `talise:tx` window event and serves the
 * immutable snapshot floor first, so this screen never flashes empty after a
 * send and history never shrinks.
 */
export function ActivityScreen() {
  const { entries, loading, error, refresh } = useActivity(50);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [selected, setSelected] = useState<ActivityRow | null>(null);
  const [open, setOpen] = useState(false);

  const rows = useMemo<ActivityRow[]>(
    () => entries.map(asRow),
    [entries]
  );
  const filtered = useMemo(
    () => rows.filter((r) => matchesFilter(r, filter)),
    [rows, filter]
  );

  const openReceipt = (row: ActivityRow) => {
    setSelected(row);
    setOpen(true);
  };

  const showSkeleton = loading && rows.length === 0;
  const activeLabel = FILTERS.find((f) => f.key === filter)?.label ?? "";

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="space-y-1">
        <Eyebrow>Activity</Eyebrow>
        <h1
          className="text-[26px] font-[500] tracking-[-0.05em] text-[#15300c] lg:text-[28px]"
          style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}
        >
          All activity
        </h1>
      </header>

      {/* Filter chips, soft pills, horizontal scroll on narrow viewports */}
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {FILTERS.map((f) => {
          const active = f.key === filter;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={active}
              className={
                active
                  ? "shrink-0 rounded-full bg-[#CAFFB8] px-4 py-1.5 text-[13px] font-medium text-[#15300c] transition-colors"
                  : "shrink-0 rounded-full border border-[#15300c]/15 bg-white/60 px-4 py-1.5 text-[13px] font-medium text-[#3a5230] backdrop-blur-sm transition-colors hover:bg-[#CAFFB8] hover:text-[#15300c]"
              }
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* List, skeleton / error / empty / rows */}
      {showSkeleton ? (
        <div>
          {Array.from({ length: 7 }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      ) : error && entries.length === 0 ? (
        <GlassCard
          className="flex items-center justify-between gap-3 px-4 py-4"
        >
          <span className="text-[14px] text-[#3a5230]">
            Couldn&apos;t load your activity.
          </span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-full border-2 border-[#15300c] px-3.5 py-1.5 text-[13px] font-medium text-[#15300c] transition-colors hover:bg-[#15300c] hover:text-[#f7fcf2]"
          >
            Retry
          </button>
        </GlassCard>
      ) : filtered.length === 0 ? (
        <div className="pt-4">
          <EmptyState
            icon={<HugeiconsIcon icon={InboxIcon} size={26} strokeWidth={1.8} />}
            title={
              filter === "all"
                ? "No activity yet"
                : `No ${activeLabel.toLowerCase()} activity`
            }
            subtitle={
              filter === "all"
                ? "Your sends, receipts, earnings and swaps will appear here."
                : "Nothing here yet, try a different filter."
            }
            action={
              filter === "all" ? (
                <PrimaryButton href="/app/pay">Send money</PrimaryButton>
              ) : undefined
            }
          />
        </div>
      ) : (
        /* Flat list, borderless rows need no card wrapper or inter-row gap;
           the hover fill on each row gives visual separation on interaction. */
        <div>
          {filtered.map((row) => (
            <HistoryRow
              key={rowKey(row)}
              row={row}
              onOpen={() => openReceipt(row)}
            />
          ))}
        </div>
      )}

      <ReceiptSheet row={selected} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

/** Stable list key, digest when present, else a synthetic composite. */
function rowKey(row: ActivityRow): string {
  if (row.digest && row.digest.length > 0) return row.digest;
  return `${row.direction}:${row.timestampMs}:${row.amountUsdsui ?? ""}:${row.amountSui ?? ""}`;
}

/** Skeleton row sized to match the real HistoryRow (size-9 badge, two text lines). */
function SkeletonRow() {
  return (
    <div className="flex w-full items-center gap-3 px-3 py-3">
      <span className="size-9 shrink-0 animate-pulse rounded-full bg-[#15300c]/10" />
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="h-3 w-28 animate-pulse rounded-full bg-[#15300c]/10" />
        <span className="h-2.5 w-20 animate-pulse rounded-full bg-[#15300c]/[0.07]" />
      </span>
      <span className="h-3.5 w-16 animate-pulse rounded-full bg-[#15300c]/10" />
    </div>
  );
}
