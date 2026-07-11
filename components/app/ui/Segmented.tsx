"use client";

import type { ReactNode } from "react";

export type SegmentedOption<T extends string | number> = {
  value: T;
  label: ReactNode;
};

export type SegmentedProps<T extends string | number> = {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  /** Stack vertically (for long labels) instead of an equal-width row. */
  stack?: boolean;
};

/**
 * A glass segmented control — the styled replacement for a native `<select>`
 * when the choice set is small. Selected segment fills with the accent green
 * (#CAFFB8); the rest are quiet. Matches OptionRow / Field aesthetics.
 */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  stack = false,
}: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`flex w-full gap-1 rounded-xl border border-[#15300c]/15 bg-white/50 p-1 backdrop-blur-sm ${
        stack ? "flex-col" : ""
      }`}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={`flex-1 rounded-lg px-2 py-2 text-[13px] font-medium transition-[background-color,color,transform] duration-150 ${
              active
                ? "bg-[#CAFFB8] text-[#15300c] shadow-sm"
                : "text-[#3d7a29] hover:bg-[#CAFFB8]/40 active:scale-[0.98]"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
