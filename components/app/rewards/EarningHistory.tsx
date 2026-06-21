"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { GlassCard, MicroLabel } from "@/components/app";
import type { ReferralEvent } from "./types";

/** How many rows show before the "See all" fold. Matches iOS. */
const FOLD = 5;

/**
 * Map a rewards-event kind slug to a human title. Unknown kinds get the
 * slug humanized (underscores → spaces, sentence case) so new server
 * event kinds still read sensibly. Mirrors iOS `historyTitle`.
 */
function eventTitle(kind: string): string {
  switch (kind) {
    case "send":
    case "send_tx":
      return "Sent money";
    case "invest":
    case "supply":
      return "Saved to yield";
    case "roundup":
    case "roundup_sweep":
      return "Round-up auto-save";
    case "goal":
    case "goal_deposit":
      return "Added to a goal";
    case "referral":
    case "referee":
    case "referrer":
      return "Friend joined";
    default: {
      const words = kind.replace(/_/g, " ");
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
  }
}

/** Short date ("4 Jun 2026") — same shape as the iOS history rows. */
function eventDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Earning history: the 5 most recent point events in one hairline-divided
 * card, with a "See all" row that expands the rest of the server ledger
 * inline. Points only — no money amounts, so no privacy masking needed.
 * Renders nothing when there's no history yet. Mirrors iOS `historySection`.
 */
export function EarningHistory({ events }: { events: ReferralEvent[] }) {
  const [showAll, setShowAll] = useState(false);
  if (events.length === 0) return null;

  const shown = showAll ? events : events.slice(0, FOLD);

  return (
    <section className="space-y-2.5">
      <MicroLabel>Earning history</MicroLabel>
      <GlassCard className="overflow-hidden !p-0">
        {shown.map((ev, i) => (
          <div key={ev.id}>
            {i > 0 && <div className="mx-4 h-px bg-[#15300c]/10" />}
            <div className="flex items-center gap-3 px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <p className="text-[14px] text-[#15300c]">{eventTitle(ev.kind)}</p>
                <p className="mt-0.5 font-mono text-[10px] text-[#3d7a29]">
                  {eventDate(ev.createdAt)}
                </p>
              </div>
              <span className="shrink-0 text-[14px] font-medium text-[#3d7a29] tabular-nums">
                +{ev.points.toLocaleString()}
              </span>
            </div>
          </div>
        ))}

        {/* "See all" — only when there's more than the fold. */}
        {!showAll && events.length > FOLD && (
          <>
            <div className="mx-4 h-px bg-[#15300c]/10" />
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="flex w-full items-center justify-between px-5 py-3.5 text-left transition-colors hover:bg-[#CAFFB8]/40"
            >
              <span className="text-[13px] font-medium text-[#3d7a29]">See all</span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={14}
                className="text-[#3d7a29]"
                strokeWidth={2}
              />
            </button>
          </>
        )}
      </GlassCard>
    </section>
  );
}
