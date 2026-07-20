"use client";

/**
 * Read-data hooks for the app. Each wraps an `/api/*` endpoint with simple
 * fetch-on-mount + revalidate semantics. The /api/balances and /api/activity
 * snapshots are DISPLAY-ONLY, pass `fresh` (refreshFresh / refresh) right
 * after a tx to bypass the snapshot caches.
 *
 * A global `talise:tx` window event (dispatched by useSignAndSend after a
 * successful send) triggers a fresh re-pull of balances + activity so the UI
 * reflects money movement without a manual refresh.
 */

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";

// ── SWR-lite shared cache ──────────────────────────────────────────────────
// Every read hook is backed by one module-level cache keyed by endpoint, with
// in-flight de-dupe + cross-component subscription + background revalidation.
// Why this matters:
//   • SPEED, navigating between screens renders the cached value INSTANTLY
//     (no per-screen refetch waterfall / loading flash).
//   • CONSISTENCY, every component that reads balances sees the same number
//     (this is what was causing the Send screen to flash "₦0" while the
//     dashboard showed the real balance, each hook fetched on its own).
//   • EFFICIENCY, N components mounting the same endpoint = ONE request.
// (This is browser code, so Date.now()/timers are fine here.)

type CacheEntry = {
  data?: unknown;
  error?: ApiError;
  promise?: Promise<void>;
  fetchedAt?: number;
  subs: Set<() => void>;
  fetcher?: (fresh: boolean) => Promise<unknown>;
};

const cache = new Map<string, CacheEntry>();

function entryFor(key: string): CacheEntry {
  let e = cache.get(key);
  if (!e) {
    e = { subs: new Set() };
    cache.set(key, e);
  }
  return e;
}

/**
 * Pre-populate a cache key with a server-resolved value (e.g. AppShell seeds
 * `/api/me` from the session the layout already resolved). Avoids a redundant
 * client round-trip on load and keeps the value authoritative. No-op if a
 * client value already landed.
 */
export function seedResource(key: string, data: unknown) {
  const e = entryFor(key);
  if (e.data === undefined) {
    e.data = data;
    e.fetchedAt = Date.now();
    e.subs.forEach((fn) => fn());
  }
}

function revalidate(key: string, fresh: boolean): Promise<void> {
  const e = entryFor(key);
  if (!e.fetcher) return Promise.resolve();
  if (e.promise && !fresh) return e.promise; // de-dupe concurrent loads
  const fetcher = e.fetcher;
  const p = (async () => {
    try {
      e.data = await fetcher(fresh);
      e.error = undefined;
      e.fetchedAt = Date.now();
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : new ApiError(0, String(err));
      e.error = apiErr;
      // Session expired / unauthenticated → drop any stale value so the gate
      // (useMe → AppShell) flips to the sign-in screen immediately, WITHOUT a
      // reload. This is the client-side auto-logout: the /api/me poll catches
      // the lapsed session and the shell signs the user out on the spot.
      if (apiErr.status === 401) {
        e.data = undefined;
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("talise:session-expired"));
        }
      }
    } finally {
      e.promise = undefined;
      e.subs.forEach((fn) => fn());
    }
  })();
  e.promise = p;
  e.subs.forEach((fn) => fn()); // announce load start (no-op if value already cached)
  return p;
}

function useResource<T>(key: string, fetcher: (fresh: boolean) => Promise<T>) {
  const e = entryFor(key);
  e.fetcher = fetcher as (fresh: boolean) => Promise<unknown>; // keep latest closure
  const [, bump] = useState(0);

  useEffect(() => {
    const en = entryFor(key);
    const rerender = () => bump((n) => n + 1);
    en.subs.add(rerender);
    // Fetch once if we've never resolved this key; otherwise the cached value
    // renders immediately and we revalidate quietly in the background.
    if (en.data === undefined && en.error === undefined && !en.promise) {
      void revalidate(key, false);
    } else if (en.data !== undefined && en.fetchedAt && Date.now() - en.fetchedAt > 30_000) {
      void revalidate(key, false);
    }
    return () => {
      en.subs.delete(rerender);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const refresh = useCallback(
    (fresh = true) => revalidate(key, fresh),
    [key]
  );

  return {
    data: e.data as T | undefined,
    error: e.error ?? null,
    loading: e.data === undefined && e.error === undefined,
    refresh,
  };
}

// One global listener: a successful tx force-revalidates balances + activity
// across every mounted component at once.
(function wireTxOnce() {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __taliseTxWired?: boolean };
  if (w.__taliseTxWired) return;
  w.__taliseTxWired = true;
  window.addEventListener("talise:tx", () => {
    for (const key of cache.keys()) {
      if (key.startsWith("/api/balances") || key.startsWith("/api/activity")) {
        void revalidate(key, true);
      }
    }
  });
})();

// ── Shared shapes ───────────────────────────────────────────────────────

export type Me = {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  country: string | null;
  suiAddress: string;
  taliseHandle: string | null;
  accountType: string;
};

export type Balances = {
  address: string;
  usdsui: number;
  sui: number;
  suiPriceUsd: number;
  totalUsd: number;
  refreshedAt: number;
  stale: boolean;
};

export type ActivityEntry = {
  digest: string;
  timestampMs: number;
  direction: "sent" | "received";
  amountUsdsui: number;
  amountSui: number;
  counterparty: string;
  counterpartyName: string | null;
  venue: string | null;
  roundupUsdsui: number;
  otherCoin: string | null;
  /**
   * Present on USDsui→NGN bank cash-out rows (a "sent" tx whose recipient is a
   * Linq off-ramp deposit wallet). `status` is Linq's free text.
   */
  offramp?: {
    provider: "linq";
    amountNgn: number;
    bankName: string | null;
    accountLast4: string | null;
    status: string;
    rate: number;
    orderId: string;
  } | null;
};

export type Contact = {
  address: string;
  name: string | null;
  lastSeenMs: number;
  sentCount: number;
  receivedCount: number;
};

// ── useMe ────────────────────────────────────────────────────────────────

export function useMe() {
  const { data, error, loading, refresh } = useResource<Me>("/api/me", (fresh) =>
    api<Me>("/api/me", { fresh })
  );
  // Stable identity so consumers can safely put `refresh` in an effect dep
  // array without triggering a refetch loop (the inline arrow used to be new
  // every render).
  const refreshMe = useCallback(() => refresh(true), [refresh]);
  return { me: data ?? null, loading, error, refresh: refreshMe };
}

// ── useBalances ────────────────────────────────────────────────────────────

export function useBalances() {
  const { data, error, loading, refresh } = useResource<Balances>("/api/balances", (fresh) =>
    api<Balances>("/api/balances", { fresh })
  );
  const refreshCached = useCallback(() => refresh(false), [refresh]);
  const refreshFresh = useCallback(() => refresh(true), [refresh]);
  return { data: data ?? null, loading, error, refresh: refreshCached, refreshFresh };
}

// ── useActivity ────────────────────────────────────────────────────────────

export function useActivity(limit = 25) {
  const { data, error, loading, refresh } = useResource<{ entries: ActivityEntry[] }>(
    `/api/activity?limit=${limit}`,
    (fresh) => api<{ entries: ActivityEntry[] }>("/api/activity", { query: { limit }, fresh })
  );
  const refreshActivity = useCallback(() => refresh(true), [refresh]);
  return { entries: data?.entries ?? [], loading, error, refresh: refreshActivity };
}

// ── useContacts ────────────────────────────────────────────────────────────

export function useContacts() {
  const { data, loading } = useResource<{ contacts: Contact[] }>("/api/contacts", () =>
    api<{ contacts: Contact[] }>("/api/contacts")
  );
  return { contacts: data?.contacts ?? [], loading };
}

// ── resolveRecipient ─────────────────────────────────────────────────────

export async function resolveRecipient(
  q: string
): Promise<{ address: string; displayName: string }> {
  return api<{ address: string; displayName: string }>("/api/recipient/resolve", {
    query: { q },
  });
}
