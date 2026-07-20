"use client";

import { Eyebrow } from "@/components/app";
import { InvoicesTab } from "@/components/app/work/InvoicesTab";

/** /business/invoices, bill clients and get paid by link. */
export default function BusinessInvoicesPage() {
  return (
    <div className="space-y-6">
      <header>
        <Eyebrow>Invoices</Eyebrow>
        <h1
          className="mt-1 text-[22px] text-fg"
          style={{
            fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif',
            fontWeight: 500,
            letterSpacing: "-0.03em",
          }}
        >
          Get paid for your work
        </h1>
        <p className="mt-1 max-w-xl text-[13px] text-fg-muted">
          Send a clean invoice anyone can pay with a tap, the money lands as
          USDsui in your account, instantly.
        </p>
      </header>
      <InvoicesTab />
    </div>
  );
}
