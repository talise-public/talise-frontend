"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tiny data-fetching primitives for the admin dashboard. No SWR/react-
 * query dependency — the dashboard is internal and low-traffic, so a
 * plain fetch hook with manual refetch is enough.
 *
 * All admin API routes live under /api/admin/* and are gated by
 * requireAdminApi. The browser is already authed via the httpOnly
 * `talise_admin` cookie (or dev-open), so no extra headers are needed.
 */

export async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    if (json && typeof json === "object" && "error" in json) {
      const e = (json as { error: unknown }).error;
      if (e != null) msg = String(e);
    }
    throw new Error(msg);
  }
  return json as T;
}

export type AsyncState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
};

/**
 * Fetch `path` on mount and whenever it changes. Returns {data, error,
 * loading, refetch}. `path` should already include any query string.
 */
export function useAdminData<T>(path: string): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    adminFetch<T>(path)
      .then((d) => {
        if (!cancelled && mounted.current) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled && mounted.current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled && mounted.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, refetch };
}
