"use client";

import { useEffect, useRef, useState } from "react";
import { publicOrigin } from "@/lib/public-origin";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Copy01Icon,
  CheckmarkCircle02Icon,
  Share08Icon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { GlassCard, MicroLabel, PrimaryButton, useToast } from "@/components/app";

/** Build the shareable invite URL for a code, using the live origin. */
function inviteUrl(code: string): string {
  return `${publicOrigin()}/r/${code}`;
}

/**
 * Referral card: the code in mono with a Copy action, a friend-count line,
 * and a "Share Talise" button that uses the Web Share API where available
 * and falls back to copying the invite link. Mirrors iOS `referralCard`.
 */
export function ReferralCard({
  code,
  referralCount,
}: {
  code: string;
  referralCount: number;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  if (!code) return null;
  const url = inviteUrl(code);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast("Invite link copied", "success");
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      toast("Couldn't copy, long-press the code to copy it", "danger");
    }
  }

  async function share() {
    const data = {
      title: "Talise",
      text: "Join me on Talise, send and save money across borders.",
      url,
    };
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share(data);
        return;
      } catch {
        // User dismissed the share sheet, or it's unsupported, fall through
        // to copy so the action always does *something*.
      }
    }
    await copy();
  }

  return (
    <GlassCard className="space-y-4 p-7 md:p-9">
      <MicroLabel>Your referral code</MicroLabel>

      {/* Code pill, glass chip with copy action */}
      <button
        type="button"
        onClick={copy}
        className="flex w-full items-center justify-between gap-3 rounded-xl border border-[#15300c]/15 bg-white/60 px-4 py-3 text-left backdrop-blur-sm transition-[border-color] hover:border-[#15300c]/30"
      >
        <span className="truncate font-mono text-[15px] tracking-wide text-[#15300c]">{code}</span>
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-[#3d7a29]">
          <HugeiconsIcon
            icon={copied ? CheckmarkCircle02Icon : Copy01Icon}
            size={14}
            strokeWidth={1.8}
          />
          {copied ? "Copied" : "Copy"}
        </span>
      </button>

      {referralCount > 0 && (
        <div className="flex items-center gap-2 text-[12px] text-[#3d7a29]">
          <HugeiconsIcon icon={UserMultiple02Icon} size={14} strokeWidth={1.8} />
          <span>
            {referralCount} {referralCount === 1 ? "friend" : "friends"} joined with your code
          </span>
        </div>
      )}

      <PrimaryButton onClick={share} full>
        <HugeiconsIcon icon={Share08Icon} size={16} strokeWidth={1.9} />
        Share Talise
      </PrimaryButton>

      <p className="text-[11px] leading-snug text-[#3d7a29]">
        Earn points when friends join and start sending with Talise.
      </p>
    </GlassCard>
  );
}
