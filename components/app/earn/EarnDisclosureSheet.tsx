"use client";

/**
 * One-time opt-in disclosure shown before the user's FIRST supply. Regulatory
 * + framing hygiene: make it unmistakable that Earn is a SEPARATE, opt-in
 * lending service routed through a third-party DeFi protocol (NAVI) — not a
 * property of the Talise balance — and that returns vary and aren't
 * guaranteed. The supply only runs after the user taps "I understand". We
 * never auto-supply.
 */

import { HugeiconsIcon } from "@hugeicons/react";
import {
  BankIcon,
  Wallet02Icon,
  ChartIncreaseIcon,
} from "@hugeicons/core-free-icons";
import { Sheet, GlassCard, PrimaryButton } from "@/components/app";

type Point = { icon: typeof BankIcon; title: string; body: string };

const POINTS: Point[] = [
  {
    icon: BankIcon,
    title: "A separate lending service",
    body: "Earn is optional and runs through a third-party lending protocol. It's not a banking or savings product offered by Talise.",
  },
  {
    icon: Wallet02Icon,
    title: "Not part of your balance",
    body: "Money you put into Earn moves into the lending service, separate from your spendable balance. You choose what to add — nothing moves automatically.",
  },
  {
    icon: ChartIncreaseIcon,
    title: "Returns aren't guaranteed",
    body: "Rates vary and can change. Earnings are not guaranteed, and your money is not insured or protected against loss.",
  },
];

export function EarnDisclosureSheet({
  open,
  apy,
  moneyWord,
  onAccept,
  onClose,
}: {
  open: boolean;
  apy: number;
  moneyWord: string;
  onAccept: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Before you start" size="md">
      <div className="space-y-5 pb-1">
        <div className="space-y-1">
          <h2
            className="text-[20px] font-[800] uppercase tracking-[-0.02em] text-[#15300c]"
            style={{ fontFamily: "var(--font-display-v2)" }}
          >
            {apy > 0
              ? `Earn around ${(apy * 100).toFixed(2)}% on your ${moneyWord}`
              : `Earn on your ${moneyWord}`}
          </h2>
          <p className="text-[13px] text-[#3a5230]">A few things to know first.</p>
        </div>

        {/* Disclosure points — flat card with hairline dividers */}
        <GlassCard className="overflow-hidden !p-0" radius={20}>
          {POINTS.map((p, i) => (
            <div key={p.title}>
              {i > 0 && <div className="mx-4 h-px bg-[#15300c]/10" />}
              <div className="flex items-start gap-3.5 px-4 py-4">
                <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-[#CAFFB8] text-[#15300c]">
                  <HugeiconsIcon icon={p.icon} size={17} strokeWidth={1.8} />
                </span>
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold tracking-[-0.01em] text-[#15300c]">
                    {p.title}
                  </p>
                  <p className="mt-1 text-[12px] leading-snug text-[#3a5230]">{p.body}</p>
                </div>
              </div>
            </div>
          ))}
        </GlassCard>

        <p className="text-[12px] leading-snug text-[#3d7a29]">
          By continuing you&apos;re choosing to use this optional service. You can
          withdraw your money at any time. This is not financial advice.
        </p>

        <div className="space-y-2.5 pt-1">
          <PrimaryButton full onClick={onAccept}>
            I understand — continue
          </PrimaryButton>
          <PrimaryButton full variant="ghost" onClick={onClose}>
            Not now
          </PrimaryButton>
        </div>
      </div>
    </Sheet>
  );
}
