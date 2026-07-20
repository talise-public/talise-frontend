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
 * A glass segmented control, the styled replacement for a native `<select>`
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
      className={`flex w-full gap-1 rounded-[6px] border border-[var(--color-line)] bg-[var(--color-surface-2)] p-1 ${
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
            className={`flex-1 rounded-[3px] px-2 py-2 text-[12px] font-mono transition-[background-color,color,transform] duration-150 ${
              active
                ? "bg-[#CAFFB8] text-[#15300c]"
                : "text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] active:scale-[0.98]"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
