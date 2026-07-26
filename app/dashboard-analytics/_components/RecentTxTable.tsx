"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Search01Icon,
  LinkSquare02Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons";
import type { RecentTx } from "@/lib/analytics/types";

type Props = {
  txs: RecentTx[];
  /**
   * Opt-in server-side pagination. When set, the table pages through EVERY
   * transaction via `endpoint` (with server-side search) instead of only
   * filtering the `txs` it was handed. `total` seeds the count for page 1 so
   * the controls render before the first fetch. Omitted → client-side mode
   * (the admin dashboard keeps filtering its in-memory `txs`).
   */
  pagination?: { endpoint: string; total: number; pageSize?: number };
};

function shortAddr(a: string | null): string {
  if (!a) return "-";
  if (a.startsWith("0x") && a.length > 12) return `${a.slice(0, 6)}…${a.slice(-4)}`;
  return a.length > 18 ? `${a.slice(0, 16)}…` : a;
}

function relTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
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

function amountUsd(n: number | null): string {
  if (n == null) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/** Direction pill colors keyed off the normalized direction string. */
function dirStyle(dir: string): { bg: string; fg: string } {
  switch (dir) {
    case "received":
      return { bg: "rgba(61,122,41,0.12)", fg: "#2f6420" };
    case "sent":
    case "withdraw":
      return { bg: "rgba(184,80,58,0.12)", fg: "#b8503a" };
    case "swap":
    case "autoswap":
      return { bg: "rgba(184,80,58,0.08)", fg: "#8a5c2f" };
    case "invest":
      return { bg: "rgba(47,106,31,0.1)", fg: "#2f6a1f" };
    default:
      return { bg: "rgba(18,26,15,0.06)", fg: "#55634e" };
  }
}

/** Avatar tile: first letter of handle (or address), mint fill. */
function Avatar({ label }: { label: string }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-[6px] border border-[var(--color-line)] bg-[var(--color-accent-soft)] text-[12px] font-semibold uppercase text-[var(--color-fg)]">
      {label.slice(0, 1) || "?"}
    </span>
  );
}

export default function RecentTxTable({ txs, pagination }: Props) {
  const [q, setQ] = useState("");

  // ── Client-side mode (admin): filter the in-memory txs. ──────────────
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return txs;
    return txs.filter((t) => {
      const hay = `${t.handle ?? ""} ${t.address ?? ""} ${t.counterparty ?? ""} ${t.counterpartyName ?? ""} ${t.direction} ${t.digest}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [txs, q]);

  // ── Server-paginated mode (public /analytics): page through EVERY tx. ─
  const pageSize = pagination?.pageSize ?? 60;
  const endpoint = pagination?.endpoint;
  const [rows, setRows] = useState<RecentTx[]>(txs);
  const [total, setTotal] = useState(pagination?.total ?? txs.length);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0); // guards against out-of-order responses

  // Fetch a page from the server (debounced by the caller effect).
  const fetchPage = useCallback(
    async (nextOffset: number, needle: string) => {
      if (!endpoint) return;
      const mine = ++seq.current;
      setBusy(true);
      try {
        const url = `${endpoint}?limit=${pageSize}&offset=${nextOffset}${needle ? `&q=${encodeURIComponent(needle)}` : ""}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { rows: RecentTx[]; total: number };
        if (mine !== seq.current) return; // a newer request won
        setRows(json.rows);
        setTotal(json.total);
        setOffset(nextOffset);
      } catch {
        if (mine === seq.current) setBusy(false);
        return;
      }
      if (mine === seq.current) setBusy(false);
    },
    [endpoint, pageSize],
  );

  // When the parent hands down a fresh first page (initial load / Refresh),
  // adopt it — but only while sitting on page 1 with no active search, so we
  // never clobber a page the user paged/searched into.
  useEffect(() => {
    if (!endpoint) return;
    if (offset === 0 && q.trim() === "") {
      setRows(txs);
      setTotal(pagination?.total ?? txs.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txs, pagination?.total]);

  // Debounce the search box → refetch page 1 for the new needle.
  useEffect(() => {
    if (!endpoint) return;
    const needle = q.trim().toLowerCase();
    const id = setTimeout(() => void fetchPage(0, needle), 280);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const paginated = !!endpoint;
  const displayRows = paginated ? rows : filtered;
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + displayRows.length, total);
  const canPrev = paginated && offset > 0 && !busy;
  const canNext = paginated && end < total && !busy;
  const goPrev = () => void fetchPage(Math.max(0, offset - pageSize), q.trim().toLowerCase());
  const goNext = () => void fetchPage(offset + pageSize, q.trim().toLowerCase());

  return (
    <section className="overflow-hidden rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)]">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-6 sm:px-7">
        <div>
          <span className="font-mono text-[11px] uppercase tracking-[0.28em] text-[var(--color-accent)]">
            Recent transactions
          </span>
          <h2
            className="mt-1 text-[22px] leading-[1.05] text-[var(--color-fg)]"
            style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif', fontWeight: 500, letterSpacing: "-0.03em" }}
          >
            {paginated ? (
              <>
                {new Intl.NumberFormat("en-US").format(start)}–
                {new Intl.NumberFormat("en-US").format(end)} of{" "}
                {new Intl.NumberFormat("en-US").format(total)}
              </>
            ) : (
              <>{new Intl.NumberFormat("en-US").format(filtered.length)} shown</>
            )}
          </h2>
        </div>
        <label className="flex h-10 items-center gap-2 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3.5">
          <HugeiconsIcon icon={Search01Icon} size={16} strokeWidth={1.8} color="var(--color-accent)" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search user, counterparty, digest…"
            className="w-44 bg-transparent text-[13px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-dim)] focus:outline-none sm:w-56"
          />
        </label>
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left">
          <thead>
            <tr className="border-y border-[var(--color-line)] font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-accent)]">
              <th className="px-6 py-2.5 font-medium sm:px-7">When</th>
              <th className="px-3 py-2.5 font-medium">User</th>
              <th className="px-3 py-2.5 font-medium">Direction</th>
              <th className="px-3 py-2.5 text-right font-medium">Amount</th>
              <th className="px-3 py-2.5 font-medium">Counterparty</th>
              <th className="px-6 py-2.5 text-right font-medium sm:px-7">Tx</th>
            </tr>
          </thead>
          <tbody>
            {displayRows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-12 text-center text-[14px] text-[var(--color-fg-muted)] sm:px-7">
                  {total === 0 && q.trim() === "" ? "No transactions indexed yet." : "No matches."}
                </td>
              </tr>
            ) : (
              displayRows.map((t) => {
                const who = t.handle ? `${t.handle}@talise` : shortAddr(t.address);
                const ds = dirStyle(t.direction);
                const cp = t.counterpartyName ?? shortAddr(t.counterparty);
                return (
                  <tr
                    key={t.digest}
                    className="border-b border-[var(--color-line)] transition-colors hover:bg-[var(--color-surface-2)]"
                  >
                    <td className="px-6 py-3 font-mono text-[12px] text-[var(--color-fg-muted)] sm:px-7">
                      {relTime(t.ts)}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2.5">
                        <Avatar label={t.handle ?? t.address ?? "?"} />
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-[var(--color-fg)]">
                            {who}
                          </div>
                          {t.handle && (
                            <div className="truncate font-mono text-[11px] text-[var(--color-fg-dim)]">
                              {shortAddr(t.address)}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className="inline-flex rounded-[6px] px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.06em]"
                        style={{ background: ds.bg, color: ds.fg }}
                      >
                        {t.direction || "-"}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right text-[13px] font-semibold tabular-nums text-[var(--color-fg)]">
                      {amountUsd(t.amountUsd)}
                    </td>
                    <td className="px-3 py-3 text-[12px] text-[var(--color-fg-muted)]">
                      <span className={t.counterpartyName ? "" : "font-mono"}>{cp}</span>
                    </td>
                    <td className="px-6 py-3 text-right sm:px-7">
                      {t.digest ? (
                        <a
                          href={`https://suivision.xyz/txblock/${t.digest}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--color-accent)] hover:text-[var(--color-fg)]"
                        >
                          {t.digest.slice(0, 6)}…
                          <HugeiconsIcon icon={LinkSquare02Icon} size={13} strokeWidth={1.8} />
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {paginated ? (
        <div className="flex items-center justify-between gap-3 border-t border-[var(--color-line)] px-6 py-4 sm:px-7">
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-fg-muted)]">
            {total === 0
              ? "No transactions"
              : `Page ${Math.floor(offset / pageSize) + 1} of ${Math.max(1, Math.ceil(total / pageSize))}`}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={goPrev}
              disabled={!canPrev}
              className="inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 text-[13px] font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.8} />
              Prev
            </button>
            <button
              type="button"
              onClick={goNext}
              disabled={!canNext}
              className="inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 text-[13px] font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
              <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      ) : (
        <div className="h-2" />
      )}
    </section>
  );
}
