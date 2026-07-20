"use client";

import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  RefreshIcon,
  AlertCircleIcon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import type { AnalyticsSummary } from "@/lib/analytics/types";
import KpiCards from "@/app/dashboard-analytics/_components/KpiCards";
import RecentTxTable from "@/app/dashboard-analytics/_components/RecentTxTable";

const num = (n: number): string =>
  new Intl.NumberFormat("en-US").format(Number.isFinite(n) ? n : 0);

function relTime(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "never";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Public network dashboard. Same layout as the admin AnalyticsClient (progress
 * strip + KPI cards + recent-tx feed) but reads the public /api/analytics/network
 * endpoint and drops the admin-only "Index now" control — the cron drives
 * indexing; visitors only read.
 */
export default function PublicAnalyticsClient() {
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/analytics/network", { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to load analytics (${res.status}).`);
      const json = (await res.json()) as AnalyticsSummary;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load analytics.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchSummary();
  }, [fetchSummary]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void fetchSummary();
  }, [fetchSummary]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <button
          type="button"
          onClick={refresh}
          disabled={loading || refreshing}
          className="bp-btn bp-btn-solid"
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            size={16}
            strokeWidth={1.8}
            className={refreshing ? "animate-spin" : ""}
          />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)] p-5 text-[14px] text-[#b8503a]">
          <HugeiconsIcon
            icon={AlertCircleIcon}
            size={20}
            strokeWidth={1.8}
            className="mt-0.5 shrink-0"
          />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <LoadingSkeleton />
      ) : data ? (
        <>
          <IndexFreshnessStrip index={data.index} />
          <KpiCards totals={data.totals} />
          <RecentTxTable txs={data.recent} />
        </>
      ) : null}
    </div>
  );
}

function IndexFreshnessStrip({ index }: { index: AnalyticsSummary["index"] }) {
  const total = index.totalUsers || 0;
  const done = index.indexedUsers;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const fullPassDone = index.fullPassAt != null;

  return (
    <section className="rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)] px-6 py-5 sm:px-7">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.28em] text-[var(--color-accent)]">
            On-chain index
          </span>
          <span className="tabular-nums text-[14px] font-semibold text-[var(--color-fg)]">
            Indexed {num(done)} / {num(total)} users
          </span>
          <span className="tabular-nums text-[13px] font-medium text-[var(--color-accent)]">
            {pct}%
          </span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-fg-muted)]">
          <span>Last run {relTime(index.lastRunAt)}</span>
          {fullPassDone && (
            <span className="inline-flex items-center gap-1 text-[var(--color-accent)]">
              <HugeiconsIcon icon={CheckmarkCircle02Icon} size={14} strokeWidth={1.8} />
              Full pass {relTime(index.fullPassAt)}
            </span>
          )}
        </div>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-[3px] bg-[var(--color-surface-2)]">
        <div
          className="h-full rounded-[3px] bg-[var(--color-accent-deep)] transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </section>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true">
      <div className="h-[88px] animate-pulse rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)]" />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className={`h-[152px] animate-pulse rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)] ${i === 0 ? "sm:col-span-2" : ""}`}
          />
        ))}
      </div>
      <div className="h-[420px] animate-pulse rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)]" />
    </div>
  );
}
