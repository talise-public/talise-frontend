"use client";

import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Search01Icon, LinkSquare02Icon } from "@hugeicons/core-free-icons";
import type { RecentTx } from "@/lib/analytics/types";

type Props = { txs: RecentTx[] };

function shortAddr(a: string | null): string {
  if (!a) return "—";
  if (a.startsWith("0x") && a.length > 12) return `${a.slice(0, 6)}…${a.slice(-4)}`;
  return a.length > 18 ? `${a.slice(0, 16)}…` : a;
}

function relTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
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
  if (n == null) return "—";
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
      return { bg: "rgba(192,83,47,0.12)", fg: "#c0532f" };
    case "swap":
    case "autoswap":
      return { bg: "rgba(255,158,122,0.18)", fg: "#b5491f" };
    case "invest":
      return { bg: "rgba(255,229,158,0.35)", fg: "#7a5a12" };
    default:
      return { bg: "rgba(21,48,12,0.06)", fg: "#3a5230" };
  }
}

/** Avatar disc: first letter of handle (or address), mint bg. */
function Avatar({ label }: { label: string }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#CAFFB8] text-[12px] font-semibold uppercase text-[#15300c]">
      {label.slice(0, 1) || "?"}
    </span>
  );
}

export default function RecentTxTable({ txs }: Props) {
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return txs;
    return txs.filter((t) => {
      const hay = `${t.handle ?? ""} ${t.address ?? ""} ${t.counterparty ?? ""} ${t.counterpartyName ?? ""} ${t.direction} ${t.digest}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [txs, q]);

  return (
    <section
      className="overflow-hidden rounded-[28px] bg-[#f7fcf2]"
      style={{ boxShadow: "10px 10px 0 #15300c" }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-6 sm:px-7">
        <div>
          <span className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
            Recent transactions
          </span>
          <h2
            className="mt-1 text-[22px] font-[800] uppercase tracking-[-0.02em] text-[#15300c]"
            style={{ fontFamily: "var(--font-display-v2)" }}
          >
            {new Intl.NumberFormat("en-US").format(txs.length)} shown
          </h2>
        </div>
        <label className="flex h-10 items-center gap-2 rounded-full border border-[#15300c]/12 bg-white/60 px-3.5">
          <HugeiconsIcon icon={Search01Icon} size={16} strokeWidth={1.8} color="#3d7a29" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search user, counterparty, digest…"
            className="w-44 bg-transparent text-[13px] text-[#15300c] placeholder:text-[#3d7a29]/60 focus:outline-none sm:w-56"
          />
        </label>
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left">
          <thead>
            <tr className="border-y border-[#15300c]/10 font-mono text-[10px] uppercase tracking-[0.18em] text-[#3d7a29]">
              <th className="px-6 py-2.5 font-medium sm:px-7">When</th>
              <th className="px-3 py-2.5 font-medium">User</th>
              <th className="px-3 py-2.5 font-medium">Direction</th>
              <th className="px-3 py-2.5 text-right font-medium">Amount</th>
              <th className="px-3 py-2.5 font-medium">Counterparty</th>
              <th className="px-6 py-2.5 text-right font-medium sm:px-7">Tx</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-12 text-center text-[14px] text-[#3a5230] sm:px-7">
                  {txs.length === 0 ? "No transactions indexed yet." : "No matches."}
                </td>
              </tr>
            ) : (
              filtered.map((t) => {
                const who = t.handle ? `${t.handle}@talise` : shortAddr(t.address);
                const ds = dirStyle(t.direction);
                const cp = t.counterpartyName ?? shortAddr(t.counterparty);
                return (
                  <tr
                    key={t.digest}
                    className="border-b border-[#15300c]/[0.06] transition-colors hover:bg-[#CAFFB8]/15"
                  >
                    <td className="px-6 py-3 text-[13px] text-[#3a5230] sm:px-7">
                      {relTime(t.ts)}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2.5">
                        <Avatar label={t.handle ?? t.address ?? "?"} />
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-[#15300c]">
                            {who}
                          </div>
                          {t.handle && (
                            <div className="truncate font-mono text-[11px] text-[#3d7a29]/80">
                              {shortAddr(t.address)}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className="inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium capitalize"
                        style={{ background: ds.bg, color: ds.fg }}
                      >
                        {t.direction || "—"}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right text-[13px] font-semibold tabular-nums text-[#15300c]">
                      {amountUsd(t.amountUsd)}
                    </td>
                    <td className="px-3 py-3 text-[12px] text-[#3a5230]">
                      <span className={t.counterpartyName ? "" : "font-mono"}>{cp}</span>
                    </td>
                    <td className="px-6 py-3 text-right sm:px-7">
                      {t.digest ? (
                        <a
                          href={`https://suivision.xyz/txblock/${t.digest}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-[11px] text-[#3d7a29] hover:text-[#15300c]"
                        >
                          {t.digest.slice(0, 6)}…
                          <HugeiconsIcon icon={LinkSquare02Icon} size={13} strokeWidth={1.8} />
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="h-2" />
    </section>
  );
}
