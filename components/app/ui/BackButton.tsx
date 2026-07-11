"use client";

import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";

export type BackButtonProps = {
  /** Where to go. Omit to use the browser's back (router.back()). */
  href?: string;
  label?: string;
};

/**
 * Small glass "back" pill for sub-pages. Pushes `href` when given, else falls
 * back to the browser history. Matches the OptionRow / chip aesthetic.
 */
export function BackButton({ href, label = "Back" }: BackButtonProps) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => (href ? router.push(href) : router.back())}
      className="inline-flex items-center gap-1.5 rounded-full border border-[#15300c]/12 bg-white/60 px-3 py-1.5 text-[12px] font-medium text-[#3a5230] backdrop-blur-sm transition-colors hover:bg-[#CAFFB8] hover:text-[#15300c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3d7a29]/45"
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} size={14} strokeWidth={2} />
      {label}
    </button>
  );
}
