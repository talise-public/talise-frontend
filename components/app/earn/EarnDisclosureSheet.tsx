"use client";

/**
 * One-time, friendly intro shown before the user's FIRST supply. Kept
 * deliberately light: a calm one-liner that Earn is optional and routed through
 * a third-party DeFi protocol (NAVI), and that they can move their money back
 * anytime. No alarming "not guaranteed / not insured / not your balance"
 * framing, just a soft heads-up. The supply only runs after "Start earning".
 */

import { Sheet, PrimaryButton } from "@/components/app";

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
    <Sheet open={open} onClose={onClose} title="About Earn" size="md">
      <div className="space-y-5 pb-1">
        <div className="space-y-2">
          <h2
            className="text-[20px] font-[500] tracking-[-0.05em] text-[#15300c]"
            style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}
          >
            {apy > 0
              ? `Earn around ${(apy * 100).toFixed(2)}% on your ${moneyWord}`
              : `Earn on your ${moneyWord}`}
          </h2>
          <p className="text-[14px] leading-[1.55] text-[#3a5230]">
            Put your {moneyWord} to work through NAVI, a trusted DeFi protocol, and
            move it back to your balance whenever you like.
          </p>
        </div>

        <p className="text-[12px] leading-snug text-[#3d7a29]">
          Earn is optional, and rates move with the market.
        </p>

        <div className="space-y-2.5 pt-1">
          <PrimaryButton full onClick={onAccept}>
            Start earning
          </PrimaryButton>
          <PrimaryButton full variant="ghost" onClick={onClose}>
            Maybe later
          </PrimaryButton>
        </div>
      </div>
    </Sheet>
  );
}
