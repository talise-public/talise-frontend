"use client";

/**
 * "Do more with your money", the companion card beside the identity card on
 * Home (mirrors Wise's right-hand tile). Nudges idle balance into Earn with a
 * single forest + button. Soft-fill card, calm copy.
 */

import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { Eyebrow } from "@/components/app";

export function DoMoreCard() {
  return (
    <Link
      href="/app/earn"
      style={{ boxShadow: "0 1px 2px rgba(18,26,15,0.04), 0 14px 34px -22px rgba(18,26,15,0.22)" }}
      className="group relative flex h-full min-h-[180px] flex-col justify-between rounded-[16px] bg-[#CAFFB8] p-7 text-[#15300c] transition-transform duration-200 ease-out hover:-translate-y-0.5 active:translate-y-0 md:p-9 outline-none focus-visible:ring-2 focus-visible:ring-[#3d7a29]/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[#edf0ea]"
    >
      <span aria-hidden className="bp-bracket" />
      <span aria-hidden className="bp-bracket-2" />
      <div>
        <Eyebrow>Do more with your money</Eyebrow>
        <p className="mt-3 max-w-[26ch] text-[13.5px] leading-relaxed text-[#3a5230]" style={{ fontFamily: "var(--font-mono), monospace" }}>
          Put idle dollars to work and earn on your balance, withdraw anytime.
        </p>
      </div>
      <span className="mt-5 inline-flex items-center gap-3">
        <span
          className="flex size-11 items-center justify-center rounded-[8px] bg-[#15300c] text-[#f7fcf2] transition-transform group-hover:scale-105"
          aria-hidden
        >
          <HugeiconsIcon icon={Add01Icon} size={20} strokeWidth={2.2} color="currentColor" />
        </span>
        <span className="text-[12px] uppercase tracking-[0.06em] text-[#15300c]" style={{ fontFamily: "var(--font-mono), monospace" }}>Start earning</span>
      </span>
    </Link>
  );
}
