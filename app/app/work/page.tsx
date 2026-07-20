"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Invoice01Icon, UserGroupIcon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import { InvoicesTab } from "@/components/app/work/InvoicesTab";
import { ContractsTab } from "@/components/app/work/ContractsTab";
import { PayoutsTab } from "@/components/app/work/PayoutsTab";

type Tab = "invoices" | "contracts" | "payouts";

/**
 * /app/work, the Work hub: get paid for work (Invoices) and pay your team
 * (Contracts, recurring streamed pay). Two tabs over a shared header.
 */
export default function WorkPage() {
  const [tab, setTab] = useState<Tab>("invoices");

  return (
    <div className="space-y-6">
      <header>
        <div className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
          Work
        </div>
        <h1
          className="mt-2 text-[clamp(24px,4vw,34px)] font-[500] tracking-[-0.05em] text-[#15300c]"
          style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}
        >
          Get paid. Pay your team.
        </h1>
        <p className="mt-2 max-w-xl text-[14px] leading-[1.5] text-[#3a5230]">
          {/* Short on phones; the full pitch reads on wider screens. */}
          <span className="sm:hidden">Invoice clients. Pay your team.</span>
          <span className="hidden sm:inline">
            Send a clean invoice that anyone can pay with a tap, or set up recurring
            pay for contractors, funded once, released automatically.
          </span>
        </p>
      </header>

      {/* Tab switch */}
      <div
        className="inline-flex gap-1 rounded-full border border-[#15300c]/15 bg-white/60 p-1 backdrop-blur-sm"
        role="tablist"
        aria-label="Work sections"
      >
        <TabButton
          active={tab === "invoices"}
          onClick={() => setTab("invoices")}
          icon={<HugeiconsIcon icon={Invoice01Icon} size={15} strokeWidth={1.8} />}
          label="Invoices"
        />
        <TabButton
          active={tab === "contracts"}
          onClick={() => setTab("contracts")}
          icon={<HugeiconsIcon icon={UserGroupIcon} size={15} strokeWidth={1.8} />}
          label="Contracts"
        />
        <TabButton
          active={tab === "payouts"}
          onClick={() => setTab("payouts")}
          icon={<HugeiconsIcon icon={UserMultipleIcon} size={15} strokeWidth={1.8} />}
          label="Payouts"
        />
      </div>

      {tab === "invoices" ? (
        <InvoicesTab />
      ) : tab === "contracts" ? (
        <ContractsTab />
      ) : (
        <PayoutsTab />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors ${
        active
          ? "bg-[#15300c] text-[#f7fcf2]"
          : "text-[#3a5230] hover:text-[#15300c]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
