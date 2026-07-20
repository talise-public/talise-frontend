"use client";

/**
 * Display-currency picker for /app/settings.
 *
 * Renders a settings row (no outer border, meant to live inside a GlassCard
 * with divide-y). Opens a Sheet listing all supported display currencies.
 * Selecting one calls useCurrency().setCurrency (persisted in localStorage).
 * This is DISPLAY-ONLY, the wallet always settles in USDsui.
 */

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { UnfoldMoreIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Sheet, useCurrency, Flag } from "@/components/app";

export function CurrencyPicker() {
  const { currency, setCurrency, currencies } = useCurrency();
  const [open, setOpen] = useState(false);
  const active = currencies.find((c) => c.code === currency) ?? currencies[0];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-3.5 px-5 py-3.5 text-left transition-colors hover:bg-[#CAFFB8]/40"
      >
        {/* Circular flag chip, size-10 matches the other icon chips in this card */}
        <span className="size-10 shrink-0 overflow-hidden rounded-full ring-1 ring-[#15300c]/15">
          <Flag code={currency} size={40} className="block" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium text-[#15300c]">
            Display currency
          </span>
          <span className="block truncate text-[13px] text-[#3d7a29]">
            Changes display only, your wallet settles in USDsui.
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="rounded-full border border-[#15300c]/15 bg-white/60 px-3 py-1 text-[13px] font-medium text-[#15300c] backdrop-blur-sm">
            {active.symbol}&nbsp;{active.code}
          </span>
          <HugeiconsIcon
            icon={UnfoldMoreIcon}
            size={16}
            className="text-[#3d7a29]"
            strokeWidth={2}
          />
        </span>
      </button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Display currency"
        size="sm"
      >
        <div className="space-y-1">
          {currencies.map((c) => {
            const selected = c.code === currency;
            return (
              <button
                key={c.code}
                type="button"
                onClick={() => {
                  setCurrency(c.code);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left transition-colors ${
                  selected ? "bg-[#CAFFB8]" : "hover:bg-[#CAFFB8]/50"
                }`}
              >
                <span className="size-9 shrink-0 overflow-hidden rounded-full ring-1 ring-[#15300c]/15">
                  <Flag code={c.code} size={36} className="block" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-medium text-[#15300c]">
                    {c.label}
                  </span>
                  <span className="block font-mono text-[11px] uppercase tracking-wider text-[#3d7a29]">
                    {c.symbol} · {c.code}
                  </span>
                </span>
                {selected && (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    size={18}
                    className="shrink-0 text-[#3d7a29]"
                    strokeWidth={2.2}
                  />
                )}
              </button>
            );
          })}
        </div>
      </Sheet>
    </>
  );
}
