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
    <span className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
      {children}
    </span>
  );
}

function Figure({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="font-[800] tracking-[-0.02em] tabular-nums text-[#15300c]"
      style={{ fontFamily: "var(--font-display-v2)" }}
    >
      {children}
    </span>
  );
}

export default function KpiCards({ totals }: Props) {
  const baseCard =
    "relative flex flex-col justify-between rounded-[28px] p-6 sm:p-7 min-h-[152px]";
  const cardShadow = { boxShadow: "10px 10px 0 #15300c" } as const;

  return (
    <section>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {/* Hero — Total stablecoin volume (spans 2 cols) */}
        <div
          className={`${baseCard} sm:col-span-2 overflow-hidden bg-[#f7fcf2]`}
          style={cardShadow}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute -right-8 -top-10 h-40 w-40 rounded-full"
            style={{
              background:
                "radial-gradient(circle at 30% 30%, #FFE59E 0%, #FF9E7A 75%, transparent 100%)",
              opacity: 0.55,
            }}
          />
          <div className="relative flex items-start justify-between">
            <Eyebrow>Total stablecoin volume</Eyebrow>
            <span
              className="grid h-10 w-10 place-items-center rounded-full text-[#15300c]"
              style={{ background: "#FFE59E" }}
            >
              <HugeiconsIcon icon={MoneyBag02Icon} size={20} strokeWidth={1.8} />
            </span>
          </div>
          <div className="relative mt-4">
            <Figure>
              <span className="text-[40px] leading-none sm:text-[52px]">
                {usd(totals.stablecoinVolumeUsd)}
              </span>
            </Figure>
            <p className="mt-2 text-[13px] text-[#3a5230]">
              USDsui + USDC moved across all Talise users
            </p>
          </div>
        </div>

        {/* Total users */}
        <div className={`${baseCard} bg-[#f7fcf2]`} style={cardShadow}>
          <div className="flex items-start justify-between">
            <Eyebrow>Total users</Eyebrow>
            <span
              className="grid h-10 w-10 place-items-center rounded-full text-[#15300c]"
              style={{ background: "#CAFFB8" }}
            >
              <HugeiconsIcon icon={UserMultipleIcon} size={20} strokeWidth={1.8} />
            </span>
          </div>
          <div className="mt-4">
            <Figure>
              <span className="text-[34px] leading-none sm:text-[40px]">
                {count(totals.users)}
              </span>
            </Figure>
            <p className="mt-2 text-[13px] text-[#3a5230]">Talise accounts</p>
          </div>
        </div>

        {/* Total transactions */}
        <div className={`${baseCard} bg-[#f7fcf2]`} style={cardShadow}>
          <div className="flex items-start justify-between">
            <Eyebrow>Total transactions</Eyebrow>
            <span
              className="grid h-10 w-10 place-items-center rounded-full text-[#15300c]"
              style={{ background: "#FF9E7A" }}
            >
              <HugeiconsIcon icon={Activity01Icon} size={20} strokeWidth={1.8} />
            </span>
          </div>
          <div className="mt-4">
            <Figure>
              <span className="text-[34px] leading-none sm:text-[40px]">
                {count(totals.transactions)}
              </span>
            </Figure>
            <p className="mt-2 text-[13px] text-[#3a5230]">
              confirmed on-chain transactions
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
