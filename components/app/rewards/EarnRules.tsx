"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Sent02Icon,
  Leaf01Icon,
  ReloadIcon,
  Target01Icon,
} from "@hugeicons/core-free-icons";
import { GlassCard, MicroLabel } from "@/components/app";
import type { PointRates } from "./types";

const DEFAULTS: PointRates = { send: 1, invest: 3, withdraw: 0, roundup: 5, goal: 4 };

/**
 * Transparent "how you earn" explainer. Reads from the server's
 * `pointRates` so the numbers never drift from the engine; falls back to
 * the documented defaults on an older server build. Uniform rows, the
 * accent rate value on the right is the only thing that varies.
 */
export function EarnRules({ rates }: { rates: PointRates | null }) {
  const r = rates ?? DEFAULTS;
  const rules: { icon: typeof Sent02Icon; label: string; rate: number }[] = [
    { icon: Sent02Icon, label: "Send money", rate: r.send },
    { icon: Leaf01Icon, label: "Save to yield", rate: r.invest },
    { icon: ReloadIcon, label: "Round-up auto-save", rate: r.roundup },
    { icon: Target01Icon, label: "Add to a goal", rate: r.goal },
  ];

  return (
    <section className="space-y-2.5">
      <MicroLabel>How you earn</MicroLabel>
      <GlassCard className="overflow-hidden !p-0">
        {rules.map((rule, i) => (
          <div key={rule.label}>
            {i > 0 && <div className="mx-4 h-px bg-[#15300c]/10" />}
            <div className="flex items-center gap-3 px-5 py-3.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#CAFFB8] text-[#15300c]">
                <HugeiconsIcon icon={rule.icon} size={15} strokeWidth={1.8} />
              </span>
              <span className="flex-1 text-[13px] text-[#15300c]">{rule.label}</span>
              <span className="flex items-baseline gap-1">
                <span className="text-[14px] font-medium text-[#3d7a29] tabular-nums">
                  {rule.rate}
                </span>
                <span className="font-mono text-[10px] text-[#3d7a29]">
                  {rule.rate === 1 ? "pt / $1" : "pts / $1"}
                </span>
              </span>
            </div>
          </div>
        ))}
      </GlassCard>
    </section>
  );
}
