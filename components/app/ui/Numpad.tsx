"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon } from "@hugeicons/core-free-icons";

export type NumpadProps = {
  onKey: (d: string) => void;
  onBackspace: () => void;
  className?: string;
};

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0"] as const;

/** A 3-column numeric keypad for amount entry, digits, a decimal, backspace. */
export function Numpad({ onKey, onBackspace, className = "" }: NumpadProps) {
  return (
    <div className={`grid grid-cols-3 gap-2 ${className}`}>
      {KEYS.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onKey(k)}
          className="flex h-14 items-center justify-center rounded-2xl text-2xl font-medium text-[#15300c] tabular-nums transition-colors hover:bg-[#CAFFB8]/50 active:bg-[#CAFFB8]"
        >
          {k}
        </button>
      ))}
      <button
        type="button"
        onClick={onBackspace}
        aria-label="Delete"
        className="flex h-14 items-center justify-center rounded-2xl text-[#3a5230] transition-colors hover:bg-[#CAFFB8]/50 active:bg-[#CAFFB8]"
      >
        <HugeiconsIcon icon={Delete02Icon} size={24} strokeWidth={2} />
      </button>
    </div>
  );
}
