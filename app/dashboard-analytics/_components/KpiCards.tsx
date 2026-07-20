"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  MoneyBag02Icon,
  UserMultipleIcon,
  Activity01Icon,
} from "@hugeicons/core-free-icons";

type Props = {
  totals: {
    users: number;
    stablecoinVolumeUsd: number;
    transactions: number;
  };
};

const usd = (n: number): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);

const count = (n: number): string =>
  new Intl.NumberFormat("en-US").format(Number.isFinite(n) ? n : 0);

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[11px] uppercase tracking-[0.28em] text-[var(--color-accent)]">
      {children}
    </span>
  );
}

function Figure({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="tabular-nums tracking-[-0.02em] text-[var(--color-fg)]"
      style={{ fontFamily: "'Google Sans Variable', var(--font-sans-v2), system-ui, sans-serif" }}
    >
      {children}
    </span>
  );
}

export default function KpiCards({ totals }: Props) {
  const baseCard =
    "relative flex flex-col justify-between rounded-[10px] border border-[var(--color-line)] p-6 sm:p-7 min-h-[152px]";

  return (
    <section>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {/* Hero, Total stablecoin volume (spans 2 cols) */}
        <div className={`${baseCard} sm:col-span-2 bg-[var(--color-surface)]`}>
          <div className="flex items-start justify-between">
            <Eyebrow>Total stablecoin volume</Eyebrow>
            <span className="grid h-10 w-10 place-items-center rounded-[8px] border border-[var(--color-line)] bg-[var(--color-accent-soft)] text-[var(--color-fg)]">
              <HugeiconsIcon icon={MoneyBag02Icon} size={20} strokeWidth={1.8} />
            </span>
          </div>
          <div className="mt-4">
            <Figure>
              <span className="text-[40px] leading-none sm:text-[52px]">
                {usd(totals.stablecoinVolumeUsd)}
              </span>
            </Figure>
            <p className="mt-2 text-[13px] text-[var(--color-fg-muted)]">
              USDsui + USDC moved across all Talise users
            </p>
          </div>
        </div>

        {/* Total users */}
        <div className={`${baseCard} bg-[var(--color-surface)]`}>
          <div className="flex items-start justify-between">
            <Eyebrow>Total users</Eyebrow>
            <span className="grid h-10 w-10 place-items-center rounded-[8px] border border-[var(--color-line)] bg-[var(--color-accent-soft)] text-[var(--color-fg)]">
              <HugeiconsIcon icon={UserMultipleIcon} size={20} strokeWidth={1.8} />
            </span>
          </div>
          <div className="mt-4">
            <Figure>
              <span className="text-[34px] leading-none sm:text-[40px]">
                {count(totals.users)}
              </span>
            </Figure>
            <p className="mt-2 text-[13px] text-[var(--color-fg-muted)]">Talise accounts</p>
          </div>
        </div>

        {/* Total transactions */}
        <div className={`${baseCard} bg-[var(--color-surface)]`}>
          <div className="flex items-start justify-between">
            <Eyebrow>Total transactions</Eyebrow>
            <span className="grid h-10 w-10 place-items-center rounded-[8px] border border-[var(--color-line)] bg-[var(--color-accent-soft)] text-[var(--color-fg)]">
              <HugeiconsIcon icon={Activity01Icon} size={20} strokeWidth={1.8} />
            </span>
          </div>
          <div className="mt-4">
            <Figure>
              <span className="text-[34px] leading-none sm:text-[40px]">
                {count(totals.transactions)}
              </span>
            </Figure>
            <p className="mt-2 text-[13px] text-[var(--color-fg-muted)]">
              confirmed on-chain transactions
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
