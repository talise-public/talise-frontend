"use client";

/**
 * Earn read-data hooks + shared types.
 *
 * Wraps the Earn-area GET endpoints (yield comparison, round-up config,
 * goals, insights) with fetch-on-mount + manual refresh, mirroring the
 * pattern in `components/app/data/hooks.ts`. All of these are DISPLAY reads
 *, money movement always flows through `useEarnAction`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/components/app";
import type { EarnVenue } from "./useEarnAction";

// ── Yield comparison ─────────────────────────────────────────────────────

/** One yield venue as returned by GET /api/yield/comparison. */
export type YieldVenue = {
  venue: EarnVenue;
  apy: number;
  supplied: number;
  pendingRewards: number;
  /** NAVI-only enrichment (cumulative accrued yield, USD). */
  earned?: number;
  earningPerDay?: number;
  principalSupplied?: number;
};

export type YieldComparison = {
  venues: YieldVenue[];
  best: { venue: EarnVenue; apy: number; supplied: number } | null;
};

const VENUE_LABELS: Record<EarnVenue, string> = {
  navi: "NAVI",
  deepbook: "DeepBook",
};
export function venueLabel(v: string): string {
  return VENUE_LABELS[v as EarnVenue] ?? v.charAt(0).toUpperCase() + v.slice(1);
}

const YIELD_CACHE_KEY = "talise:yield:comparison";

export function useYieldComparison() {
  const [data, setData] = useState<YieldComparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    // Only show the skeleton on the FIRST load. Background revalidations (fired
    // by every `talise:tx`) must not flash the spinner over live cards.
    setData((cur) => {
      if (cur === null) setLoading(true);
      return cur;
    });
    try {
      const res = await api<YieldComparison>("/api/yield/comparison", { fresh: true });
      if (!mounted.current) return;
      // Stale-honest beats blank: the server returns an EMPTY comparison
      // (200, venues: []) when every venue read flakes. If we already hold
      // venues, keep the last-known cards instead of collapsing the headline
      // APY + venue list to "No live venues" mid-session (same principle as
      // the 2026-06-11 ₦0-balance incident).
      let kept = false;
      setData((cur) => {
        if (res.venues.length === 0 && cur && cur.venues.length > 0) {
          kept = true;
          return cur;
        }
        return res;
      });
      setError(null);
      if (!kept) {
        try {
          sessionStorage.setItem(YIELD_CACHE_KEY, JSON.stringify(res));
        } catch {
          /* storage blocked, non-fatal */
        }
      }
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof ApiError ? e : new ApiError(0, String(e)));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    // Stale-while-revalidate: paint the last-known comparison instantly on
    // revisit (display-only, supply/withdraw flows revalidate server-side),
    // then refresh quietly underneath.
    try {
      const raw = sessionStorage.getItem(YIELD_CACHE_KEY);
      if (raw) {
        setData(JSON.parse(raw) as YieldComparison);
        setLoading(false);
      }
    } catch {
      /* corrupt cache, foreground load below covers it */
    }
    void load();
    // A tx fires an instant reload PLUS two settle-in re-polls: right after a
    // supply confirms, the fullnode position read often still returns the
    // pre-supply figure (indexing lag), so the instant refresh alone left
    // "Supplied ₦x" stale until the next visit.
    const timers: number[] = [];
    const onTx = () => {
      void load();
      timers.push(window.setTimeout(() => void load(), 2_500));
      timers.push(window.setTimeout(() => void load(), 6_000));
    };
    window.addEventListener("talise:tx", onTx);
    return () => {
      mounted.current = false;
      timers.forEach((t) => window.clearTimeout(t));
      window.removeEventListener("talise:tx", onTx);
    };
  }, [load]);

  return { data, loading, error, refresh: load };
}

// ── Round-up config ───────────────────────────────────────────────────────

export type RoundupConfig = {
  enabled: boolean;
  percentage: number;
  savedUsd: number;
};

export function useRoundup() {
  const [config, setConfig] = useState<RoundupConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const cfg = await api<RoundupConfig>("/api/rewards/roundup");
      setConfig(cfg);
    } catch {
      /* keep last-good / null */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback(async (patch: { enabled?: boolean; percentage?: number }) => {
    const cfg = await api<RoundupConfig>("/api/rewards/roundup", {
      method: "POST",
      body: patch,
    });
    setConfig(cfg);
    return cfg;
  }, []);

  return { config, loading, update, refresh: load };
}

// ── Savings goals ──────────────────────────────────────────────────────────

export type Goal = {
  id: string;
  name: string;
  targetUsd: number;
  currentUsd: number;
  deadlineMs: number | null;
  color: string | null;
  createdAtMs: number;
  archived: boolean;
};

export function useGoals() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await api<{ goals: Goal[] }>("/api/rewards/goals");
      if (mounted.current) setGoals(res.goals ?? []);
    } catch {
      /* keep last-good */
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  return { goals, loading, refresh: load };
}

// ── Insights ────────────────────────────────────────────────────────────────

export type TopCounterparty = {
  address: string;
  name: string | null;
  count: number;
  totalUsd: number;
};

export type MonthInsights = {
  spentUsd: number;
  receivedUsd: number;
  savedUsd: number;
  monthStartMs: number;
  sampleSize: number;
  topCounterparties: TopCounterparty[];
  /**
   * True when the server's tx-history read timed out and it had no
   * last-known snapshot to serve, the zeros in this payload are NOT
   * truth. Keep the previous value / render "-", never a confident ₦0.00.
   */
  partial?: boolean;
};

export function useInsights() {
  const [data, setData] = useState<MonthInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await api<MonthInsights>("/api/rewards/insights");
      // A partial response carries fabricated zeros (server activity read
      // timed out, no snapshot), never overwrite a real value with it.
      if (mounted.current) {
        setData((cur) => (res.partial && cur && !cur.partial ? cur : res));
      }
    } catch {
      /* keep last-good */
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const onTx = () => void load();
    window.addEventListener("talise:tx", onTx);
    return () => {
      mounted.current = false;
      window.removeEventListener("talise:tx", onTx);
    };
  }, [load]);

  return { data, loading, refresh: load };
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Format an APY fraction (0.0512) as a percent string, or "-" below 1bp. */
export function formatApy(apy: number): string {
  return apy >= 0.0001 ? `${(apy * 100).toFixed(2)}%` : "-";
}

/**
 * One-time Earn opt-in disclosure acceptance, persisted in localStorage.
 * Gates the user's FIRST supply behind the lending-service disclosure.
 */
const EARN_DISCLOSURE_KEY = "talise:earn-disclosure-accepted-v1";
export function hasAcceptedEarnDisclosure(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(EARN_DISCLOSURE_KEY) === "1";
  } catch {
    return false;
  }
}
export function markEarnDisclosureAccepted(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(EARN_DISCLOSURE_KEY, "1");
  } catch {
    /* ignore */
  }
}
