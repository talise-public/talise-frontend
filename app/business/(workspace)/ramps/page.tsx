"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { BankIcon, CreditCardIcon } from "@hugeicons/core-free-icons";
import { GlassCard, Eyebrow, StatusPill, PrimaryButton } from "@/components/app";
import { WithdrawToBankSheet } from "@/components/app/ramps/WithdrawToBankSheet";

/** /business/ramps — cash out USDsui to a bank (live), add money (soon). */
export default function BusinessRampsPage() {
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  return (
    <div className="mx-auto w-full max-w-xl space-y-5 pb-8">
      {/* Page header */}
      <header>
        <Eyebrow>Cash flow</Eyebrow>
        <h1
          className="mt-1 text-[22px] font-medium text-fg"
          style={{ letterSpacing: "-0.025em" }}
        >
          Move money in and out
        </h1>
        <p className="mt-0.5 text-[13px] text-fg-muted">
          Cash out your USDsui balance to a Nigerian bank account at the live
          rate, paid out instantly via Linq.
        </p>
      </header>

      {/* Cash out — LIVE */}
      <GlassCard className="p-5">
        {/* Row: icon chip + label/title + status pill */}
        <div className="flex items-center gap-3.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <HugeiconsIcon icon={BankIcon} size={19} strokeWidth={1.9} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-medium text-fg">Withdraw to your bank</p>
            <p className="text-[12px] text-fg-dim">USDsui → NGN · no padded spreads</p>
          </div>
          <StatusPill label="Live" tone="success" />
        </div>
        <div className="mt-4 border-t border-line pt-4">
          <PrimaryButton full onClick={() => setWithdrawOpen(true)}>
            Cash out to your bank
          </PrimaryButton>
        </div>
      </GlassCard>

      {/* Add money — SOON */}
      <GlassCard className="p-5">
        <div className="flex items-center gap-3.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-fg-muted">
            <HugeiconsIcon icon={CreditCardIcon} size={19} strokeWidth={1.9} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-medium text-fg">Top up with a card or bank</p>
            <p className="text-[12px] text-fg-dim">Card or bank transfer — coming soon</p>
          </div>
          <StatusPill label="Soon" tone="pending" />
        </div>
        <p className="mt-4 text-[13px] text-fg-muted">
          For now, get paid by clients via invoices and payment links.
        </p>
      </GlassCard>

      <WithdrawToBankSheet open={withdrawOpen} onClose={() => setWithdrawOpen(false)} />
    </div>
  );
}
