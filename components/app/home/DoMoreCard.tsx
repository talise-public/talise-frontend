"use client";

/**
 * "Do more with your money" — the companion card beside the identity card on
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
      style={{ boxShadow: "10px 10px 0 #15300c" }}
      className="group flex h-full min-h-[180px] flex-col justify-between rounded-[28px] bg-[#CAFFB8] p-7 text-[#15300c] transition-transform duration-200 ease-out hover:-translate-y-0.5 active:translate-y-0 md:p-9 outline-none focus-visible:ring-2 focus-visible:ring-[#3d7a29]/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[#f7fcf2]"
    >
      <div>
        <Eyebrow>Do more with your money</Eyebrow>
        <p className="mt-3 max-w-[24ch] text-[15px] leading-relaxed text-[#3a5230]">
          Put idle dollars to work and earn on your balance, withdraw anytime.
        </p>
      </div>
      <span className="mt-5 inline-flex items-center gap-3">
        <span
          className="flex size-11 items-center justify-center rounded-full bg-[#15300c] text-[#f7fcf2] transition-transform group-hover:scale-105"
          aria-hidden
        >
          <HugeiconsIcon icon={Add01Icon} size={20} strokeWidth={2.2} color="currentColor" />
        </span>
        <span className="text-[14px] font-semibold text-[#15300c]">Start earning</span>
      </span>
    </Link>
  );
}
