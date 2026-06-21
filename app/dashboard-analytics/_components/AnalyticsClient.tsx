"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  RefreshIcon,
  AlertCircleIcon,
  Loading03Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import type { AnalyticsSummary } from "@/lib/analytics/types";
import KpiCards from "./KpiCards";
import RecentTxTable from "./RecentTxTable";

/** Mirror of BatchResult from @/lib/analytics/reindex (server-only module). */
type BatchResult = {
  processed: number;
  cursor: number;
  total: number;
  done: boolean;
  indexedAt: number;
};

/** Live progress while the "Index now" loop runs. */
type IndexProgress = { cursor: number; total: number } | null;

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

const num = (n: number): string =>
  new Intl.NumberFormat("en-US").format(Number.isFinite(n) ? n : 0);

export default function AnalyticsClient() {
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [indexing, setIndexing] = useState(false);
  const [progress, setProgress] = useState<IndexProgress>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const runningRef = useRef(false);

  const fetchSummary = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/analytics/summary", { cache: "no-store" });
      if (!res.ok) {
        throw new Error(
          res.status === 401
            ? "Not authorized."
            : `Failed to load analytics (${res.status}).`
        );
      }
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

  // Drive the indexer to completion: POST /reindex repeatedly, updating the bar
  // after each BatchResult, until done===true. Then refetch the summary.
  const indexNow = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setIndexing(true);
    setIndexError(null);
    // Seed the bar from current known progress so it does not jump from 0.
    setProgress(
      data ? { cursor: data.index.indexedUsers, total: data.index.totalUsers } : null
    );

    try {
      // Guard against an infinite loop if the server never reports done.
      for (let i = 0; i < 200; i++) {
        const res = await fetch("/api/analytics/reindex", {
          method: "POST",
          cache: "no-store",
        });
        if (!res.ok) {
          throw new Error(
            res.status === 401
              ? "Not authorized to index."
              : `Index batch failed (${res.status}).`
          );
        }
        const batch = (await res.json()) as BatchResult;
        setProgress({ cursor: batch.cursor, total: batch.total });
        if (batch.done) break;
      }
    } catch (e) {
      setIndexError(e instanceof Error ? e.message : "Indexing failed.");
    } finally {
      runningRef.current = false;
      setIndexing(false);
      setProgress(null);
      await fetchSummary();
    }
  }, [data, fetchSummary]);

  const busy = loading || refreshing || indexing;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <button
          type="button"
          onClick={indexNow}
          disabled={busy}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-[#3d7a29] px-6 text-[14px] font-semibold text-[#f7fcf2] transition-transform hover:-translate-y-0.5 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
        >
          <HugeiconsIcon
            icon={indexing ? Loading03Icon : RefreshIcon}
            size={18}
            strokeWidth={1.8}
            className={indexing ? "animate-spin" : ""}
          />
          {indexing
            ? progress
              ? `Indexing… ${num(progress.cursor)}/${num(progress.total)}`
              : "Indexing…"
            : "Index now"}
        </button>
        <button
          type="button"
          onClick={refresh}
          disabled={busy}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-[#15300c] px-6 text-[14px] font-semibold text-[#f7fcf2] transition-transform hover:-translate-y-0.5 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            size={18}
            strokeWidth={1.8}
            className={refreshing ? "animate-spin" : ""}
          />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div
          className="flex items-start gap-3 rounded-[28px] bg-[#f7fcf2] p-5 text-[14px] text-[#c0532f]"
          style={{ boxShadow: "10px 10px 0 #15300c" }}
        >
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
          <IndexProgressStrip
            index={data.index}
            live={progress}
            indexing={indexing}
            indexError={indexError}
          />
          <KpiCards totals={data.totals} />
          <RecentTxTable txs={data.recent} />
        </>
      ) : null}
    </div>
  );
}

function IndexProgressStrip({
  index,
  live,
  indexing,
  indexError,
}: {
  index: AnalyticsSummary["index"];
  live: IndexProgress;
  indexing: boolean;
  indexError: string | null;
}) {
  // Prefer the live cursor while a run is in progress; otherwise show indexed count.
  const total = (live?.total ?? index.totalUsers) || 0;
  const done = indexing && live ? live.cursor : index.indexedUsers;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const fullPassDone = index.fullPassAt != null;

  return (
    <section
      className="rounded-[28px] bg-[#f7fcf2] px-6 py-5 sm:px-7"
      style={{ boxShadow: "10px 10px 0 #15300c" }}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
            On-chain index
          </span>
          <span className="text-[14px] font-semibold tabular-nums text-[#15300c]">
            Indexed {num(done)} / {num(total)} users
          </span>
          <span className="text-[13px] font-medium tabular-nums text-[#3d7a29]">
            {pct}%
          </span>
        </div>
        <div className="flex items-center gap-3 text-[12px] text-[#3a5230]">
          <span>Last run {relTime(index.lastRunAt)}</span>
          {fullPassDone && (
            <span className="inline-flex items-center gap-1 text-[#2f6420]">
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                size={14}
                strokeWidth={1.8}
              />
              Full pass {relTime(index.fullPassAt)}
            </span>
          )}
        </div>
      </div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[#15300c]/10">
        <div
          className={`h-full rounded-full bg-[#3d7a29] transition-[width] duration-500 ease-out ${indexing ? "animate-pulse" : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {indexError && (
        <p className="mt-2 text-[12px] text-[#c0532f]">{indexError}</p>
      )}
    </section>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true">
      <div
        className="h-[88px] animate-pulse rounded-[28px] bg-[#f7fcf2]"
        style={{ boxShadow: "10px 10px 0 #15300c" }}
      />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className={`h-[152px] animate-pulse rounded-[28px] bg-[#f7fcf2] ${i === 0 ? "sm:col-span-2" : ""}`}
            style={{ boxShadow: "10px 10px 0 #15300c" }}
          />
        ))}
      </div>
      <div
        className="h-[420px] animate-pulse rounded-[28px] bg-[#f7fcf2]"
        style={{ boxShadow: "10px 10px 0 #15300c" }}
      />
    </div>
  );
}
