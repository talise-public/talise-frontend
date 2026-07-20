"use client";

/**
 * BankSelect, on-brand searchable bank picker (replaces the native <select>).
 *
 * A button that opens a search + scrollable list rendered inline (no portal,
 * so it always inherits the v2 theme). Click-outside + Escape close it.
 * Styled with the same cream/ink/mint v2 surfaces as the rest of /app.
 */

import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { LinqBank } from "@/lib/linq-banks";
import { bankLogo } from "@/lib/linq-banks";

/** Brand logo if we have one, else a letter avatar in the accent tint. */
function BankAvatar({ bank }: { bank: LinqBank }) {
  const logo = bankLogo(bank.bankCode);
  if (logo) {
    return (
      <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white ring-1 ring-[#15300c]/15">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logo} alt="" className="size-full object-contain p-0.5" />
      </span>
    );
  }
  const initial = bank.name.trim()[0]?.toUpperCase() ?? "?";
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[#CAFFB8] text-[12px] font-semibold text-[#15300c]">
      {initial}
    </span>
  );
}

export function BankSelect({
  banks,
  value,
  onChange,
  placeholder = "Select your bank",
}: {
  banks: readonly LinqBank[];
  value: string;
  onChange: (bankCode: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const selected = banks.find((b) => b.bankCode === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? banks.filter((b) => b.name.toLowerCase().includes(needle))
    : banks;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-xl bg-white/60 px-3.5 py-2.5 text-left text-[15px] outline-none ring-1 ring-[#15300c]/15 backdrop-blur-sm transition-shadow focus:ring-[#3d7a29]"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          {selected && <BankAvatar bank={selected} />}
          <span className={`truncate ${selected ? "text-[#15300c]" : "text-[#3d7a29]"}`}>
            {selected ? selected.name : placeholder}
          </span>
        </span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={18}
          strokeWidth={2}
          className={`shrink-0 text-[#3d7a29] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute z-50 mt-1.5 w-full overflow-hidden rounded-xl border border-[#15300c]/10 bg-[#f7fcf2] shadow-[0_16px_44px_-14px_rgba(21,48,12,0.28)]">
          <div className="flex items-center gap-2 border-b border-[#15300c]/10 px-3.5 py-2.5">
            <HugeiconsIcon icon={Search01Icon} size={16} strokeWidth={2} className="shrink-0 text-[#3d7a29]" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search banks"
              className="w-full bg-transparent text-[14px] text-[#15300c] outline-none placeholder:text-[#3d7a29]"
            />
          </div>
          <ul data-lenis-prevent className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <li className="px-4 py-3 text-[13px] text-[#3d7a29]">No banks match.</li>
            )}
            {filtered.map((b) => {
              const sel = b.bankCode === value;
              return (
                <li key={b.bankCode}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(b.bankCode);
                      setOpen(false);
                      setQ("");
                    }}
                    className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[14px] transition-colors hover:bg-[#CAFFB8]/50 ${
                      sel ? "text-[#3d7a29]" : "text-[#15300c]"
                    }`}
                  >
                    <BankAvatar bank={b} />
                    <span className="min-w-0 flex-1 truncate">{b.name}</span>
                    {sel && (
                      <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={2} className="shrink-0 text-[#3d7a29]" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export default BankSelect;
