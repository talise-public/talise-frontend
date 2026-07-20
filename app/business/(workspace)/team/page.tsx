"use client";

import { Eyebrow } from "@/components/app";
import { ContractsTab } from "@/components/app/work/ContractsTab";

/** /business/team, pay contractors + employees with streamed USDsui. */
export default function BusinessTeamPage() {
  return (
    <div className="space-y-6">
      <header>
        <Eyebrow>Team</Eyebrow>
        <h1
          className="mt-1 text-[22px] text-fg"
          style={{
            fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif',
            fontWeight: 500,
            letterSpacing: "-0.03em",
          }}
        >
          Pay your whole team
        </h1>
        <p className="mt-1 max-w-xl text-[13px] text-fg-muted">
          Recurring pay for contractors and employees, funded once, released
          automatically every period.
        </p>
      </header>
      <ContractsTab />
    </div>
  );
}
