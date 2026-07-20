"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkCircle02Icon,
  Cancel01Icon,
  ArrowRight02Icon,
  Copy01Icon,
} from "@hugeicons/core-free-icons";
import { GlassCard, PrimaryButton, StatusPill, Eyebrow, MicroLabel } from "@/components/app";
import { Diamond } from "@/components/Diamond";
import type { WorkInvoiceLineItem } from "@/lib/invoices";

type PublicInvoice = {
  id: string;
  amountUsd: number;
  currency: string;
  customerName: string | null;
  lineItems: WorkInvoiceLineItem[];
  memo: string | null;
  status: "open" | "paid" | "void";
  dueMs: number | null;
  createdAt: number;
  payDigest?: string | null;
  paidAt?: number | null;
};

type Issuer = { handle: string; address: string; name: string | null };

export type InvoicePayViewProps = {
  invoice: PublicInvoice;
  issuer: Issuer;
  origin: string;
};

/**
 * The public invoice page body. Renders the invoice as a classic document -
 * big "Invoice" heading with the issuer underneath, date / invoice-no / due
 * meta, a proper line-items table, totals bottom-right, payment terms + notes
 *, then a single "Pay" CTA that deep-links into /app/pay with the amount +
 * recipient prefilled. Standalone (no AppShell / CurrencyProvider) so it
 * formats its own currency locally.
 */
export function InvoicePayView({ invoice, issuer, origin }: InvoicePayViewProps) {
  const [copied, setCopied] = useState(false);

  // The invoice is stored in USD (USDsui); display it in its denominated
  // currency by applying the live FX rate. This page is public (no
  // CurrencyProvider), so it fetches the open /api/fx feed itself.
  const [rate, setRate] = useState(1);
  useEffect(() => {
    if (invoice.currency === "USD") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/fx");
        if (!res.ok) return;
        const data = (await res.json()) as { rates?: Record<string, number> };
        const r = data?.rates?.[invoice.currency];
        if (!cancelled && typeof r === "number" && r > 0) setRate(r);
      } catch {
        /* keep 1:1, better than a broken figure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [invoice.currency]);

  const fmt = useMemo(() => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: invoice.currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } catch {
      return new Intl.NumberFormat(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }
  }, [invoice.currency]);

  // `money` takes a USD figure and renders it in the invoice's currency.
  const money = (usd: number) => fmt.format(usd * rate);

  // The pay link carries the USD amount (SendFlow re-displays it in the payer's
  // currency); keep full precision so sub-dollar invoices don't round away.
  const payHref = `/app/pay?to=${encodeURIComponent(issuer.address)}&amount=${encodeURIComponent(
    invoice.amountUsd.toFixed(6)
  )}&invoice=${encodeURIComponent(invoice.id)}`;

  const statusTone =
    invoice.status === "paid" ? "completed" : invoice.status === "void" ? "danger" : "pending";
  const statusLabel =
    invoice.status === "paid" ? "Paid" : invoice.status === "void" ? "Voided" : "Awaiting payment";

  const createdLabel = new Date(invoice.createdAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const dueLabel =
    invoice.dueMs != null
      ? new Date(invoice.dueMs).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : null;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${origin}/i/${invoice.id}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked, silently ignore */
    }
  };

  const hasItems = invoice.lineItems.length > 0;
  // Subtotal is the sum of line rows (per-row rounded, same as the table);
  // the authoritative figure is always amountUsd, never recompute the total.
  const subtotalUsd = invoice.lineItems.reduce(
    (sum, li) => sum + Math.round(li.qty * li.unitUsd * 100) / 100,
    0
  );

  // Shared cell typography for the line-items table header.
  const thCls =
    "py-2.5 font-mono text-[10px] font-medium uppercase tracking-wider text-[var(--color-accent)]";

  return (
    <main className="bp-page relative min-h-dvh overflow-hidden text-[var(--color-fg)]">
      <div
        className="bp-frame relative z-10 mx-auto flex min-h-dvh w-full flex-col px-5 py-10 sm:py-16"
        style={{ maxWidth: 640 }}
      >
        <span aria-hidden className="bp-tick bp-tick-tl" />
        <span aria-hidden className="bp-tick bp-tick-tr" />
        <span aria-hidden className="bp-tick bp-tick-bl" />
        <span aria-hidden className="bp-tick bp-tick-br" />

        {/* Brand row */}
        <div className="mb-6 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 text-[var(--color-fg)]">
            <Diamond />
            <span
              className="text-[18px] font-[500] lowercase tracking-[-0.03em]"
              style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}
            >
              talise
            </span>
          </Link>
          <StatusPill label={statusLabel} tone={statusTone} />
        </div>

        <GlassCard className="overflow-hidden p-0">
          {/* Diagonal status stamp, classic rubber-stamp treatment for settled
              documents. Decorative only; the StatusPill above is the a11y label. */}
          {invoice.status !== "open" && (
            <div
              className="pointer-events-none absolute right-5 top-6 z-10 select-none sm:right-8"
              aria-hidden
            >
              <span
                className="inline-block -rotate-12 border-2 px-3 py-1 font-mono text-[16px] font-bold uppercase opacity-45 sm:text-[18px]"
                style={{
                  letterSpacing: "0.28em",
                  color: invoice.status === "paid" ? "var(--color-accent)" : "#c0532f",
                  borderColor: invoice.status === "paid" ? "var(--color-accent)" : "#c0532f",
                }}
              >
                {invoice.status === "paid" ? "Paid" : "Void"}
              </span>
            </div>
          )}

          {/* Document header, big heading, issuer underneath */}
          <div className="px-5 pb-6 pt-7 sm:px-8">
            <h1
              className="text-[34px] font-[500] leading-none tracking-[-0.03em] text-[var(--color-fg)] sm:text-[40px]"
              style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}
            >
              Invoice
            </h1>
            <p className="mt-2.5 text-[15px] font-medium text-[var(--color-fg)]">
              {issuer.name || issuer.handle}
            </p>
            {issuer.name && issuer.name !== issuer.handle && (
              <p className="mt-0.5 font-mono text-[12px] text-[var(--color-accent)]">{issuer.handle}</p>
            )}

            {/* Meta, date / invoice no / due on the left, prepared-for on the right */}
            <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
              <dl className="space-y-1.5 text-[13px]">
                <div className="flex gap-2">
                  <dt className="w-[88px] shrink-0 font-mono text-[10px] font-medium uppercase leading-[1.7] tracking-wider text-[var(--color-accent)]">
                    Date
                  </dt>
                  <dd className="text-[var(--color-fg)]">{createdLabel}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-[88px] shrink-0 font-mono text-[10px] font-medium uppercase leading-[1.7] tracking-wider text-[var(--color-accent)]">
                    Invoice no.
                  </dt>
                  <dd className="break-all font-mono text-[12px] leading-[1.6] text-[var(--color-fg-muted)]">
                    {invoice.id}
                  </dd>
                </div>
                {dueLabel && (
                  <div className="flex gap-2">
                    <dt className="w-[88px] shrink-0 font-mono text-[10px] font-medium uppercase leading-[1.7] tracking-wider text-[var(--color-accent)]">
                      Due date
                    </dt>
                    <dd className="text-[var(--color-fg)]">{dueLabel}</dd>
                  </div>
                )}
              </dl>
              {invoice.customerName && (
                <div className="sm:max-w-[45%] sm:text-right">
                  <Eyebrow>Prepared for</Eyebrow>
                  <p className="mt-1 text-[15px] font-medium text-[var(--color-fg)]">{invoice.customerName}</p>
                </div>
              )}
            </div>
          </div>

          {/* Line items, a proper document table. When the invoice has no
              itemisation, a single description row (the memo) keeps the shape. */}
          <div className="px-5 sm:px-8">
            <table className="w-full text-left text-[14px]">
              <thead>
                <tr className="border-y border-[var(--color-line)]">
                  <th className={`${thCls} pr-3`}>Description</th>
                  {hasItems && (
                    <>
                      <th className={`${thCls} px-2 text-right sm:px-3`}>Qty</th>
                      <th className={`${thCls} px-2 text-right sm:px-3`}>Unit price</th>
                    </>
                  )}
                  <th className={`${thCls} pl-3 text-right`}>Total</th>
                </tr>
              </thead>
              <tbody>
                {hasItems ? (
                  invoice.lineItems.map((li, i) => (
                    <tr key={i} className="border-b border-[var(--color-line)]">
                      <td className="py-3 pr-3 text-[var(--color-fg)]">{li.description}</td>
                      <td
                        className="px-2 py-3 text-right text-[var(--color-fg-muted)] sm:px-3"
                        style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif', fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}
                      >
                        {li.qty}
                      </td>
                      <td
                        className="whitespace-nowrap px-2 py-3 text-right text-[var(--color-fg-muted)] sm:px-3"
                        style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif', fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}
                      >
                        {money(li.unitUsd)}
                      </td>
                      <td
                        className="whitespace-nowrap py-3 pl-3 text-right font-medium text-[var(--color-fg)]"
                        style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif', fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}
                      >
                        {money(Math.round(li.qty * li.unitUsd * 100) / 100)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr className="border-b border-[var(--color-line)]">
                    <td className="py-3 pr-3 text-[var(--color-fg)]">{invoice.memo || "Amount due"}</td>
                    <td
                      className="whitespace-nowrap py-3 pl-3 text-right font-medium text-[var(--color-fg)]"
                      style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif', fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}
                    >
                      {money(invoice.amountUsd)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {/* Totals, bottom-right. No tax on Talise invoices, so it's just
                subtotal + total (or total alone for un-itemised invoices). */}
            <div className="flex justify-end py-4">
              <div className="w-full max-w-[260px] space-y-2">
                {hasItems && (
                  <div className="flex items-baseline justify-between gap-6">
                    <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-[var(--color-accent)]">
                      Subtotal
                    </span>
                    <span
                      className="text-[14px] text-[var(--color-fg-muted)]"
                      style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif', fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}
                    >
                      {money(subtotalUsd)}
                    </span>
                  </div>
                )}
                <div className="flex items-baseline justify-between gap-6 border-t border-[var(--color-line)] pt-2">
                  <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-[var(--color-fg)]">
                    Total
                  </span>
                  <span
                    className="text-[22px] font-semibold text-[var(--color-fg)]"
                    style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif', fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}
                  >
                    {money(invoice.amountUsd)}
                  </span>
                </div>
                {invoice.currency !== "USD" && (
                  <p className="text-right font-mono text-[11px] text-[var(--color-accent)]">
                    Settles as {invoice.amountUsd.toFixed(2)} USDsui · 1:1 USD
                  </p>
                )}
              </div>
            </div>

            {/* Document footer, payment terms + notes */}
            <div className="grid grid-cols-1 gap-4 border-t border-[var(--color-line)] py-5 sm:grid-cols-2">
              <div>
                <Eyebrow>Payment terms</Eyebrow>
                <p className="mt-1.5 text-[13px] text-[var(--color-fg-muted)]">
                  {dueLabel ? `Due by ${dueLabel}` : "Due on receipt"}
                </p>
              </div>
              {hasItems && invoice.memo && (
                <div>
                  <Eyebrow>Notes</Eyebrow>
                  <p className="mt-1.5 text-[13px] text-[var(--color-fg-muted)]">{invoice.memo}</p>
                </div>
              )}
            </div>
          </div>

          {/* Pay CTA / status block */}
          <div className="border-t border-[var(--color-line)] px-5 py-5 sm:px-8">
            {invoice.status === "open" ? (
              <>
                <PrimaryButton href={payHref} full>
                  <HugeiconsIcon icon={ArrowRight02Icon} size={18} strokeWidth={2} />
                  Pay {money(invoice.amountUsd)}
                </PrimaryButton>
                <p className="mt-3 text-center text-[12px] text-[var(--color-accent)]">
                  Sign in with Google to pay, no gas, no wallet setup. Money moves as USDsui.
                </p>
              </>
            ) : invoice.status === "paid" ? (
              <div className="space-y-3">
                <div className="flex items-center justify-center gap-2 rounded-[10px] bg-[var(--color-accent-light)] py-3 text-[14px] text-[var(--color-fg)]">
                  <HugeiconsIcon icon={CheckmarkCircle02Icon} size={18} strokeWidth={2} />
                  Paid
                  {invoice.paidAt
                    ? ` · ${new Date(invoice.paidAt).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}`
                    : ""}
                  . Thank you.
                </div>
                {invoice.payDigest && (
                  <div className="rounded-[10px] border border-[var(--color-line)] px-4 py-3.5">
                    <MicroLabel>On-chain receipt</MicroLabel>
                    <a
                      href={`https://suiscan.xyz/mainnet/tx/${invoice.payDigest}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-1.5 block break-all font-mono text-[12px] text-[var(--color-accent)] underline-offset-2 hover:underline"
                    >
                      {invoice.payDigest}
                    </a>
                    <p className="mt-1.5 text-[11px] text-[var(--color-accent)]">
                      Settled on Sui, verify this payment on-chain.
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-center gap-2 rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface-2)] py-3 text-[14px] text-[var(--color-fg-muted)]">
                <HugeiconsIcon icon={Cancel01Icon} size={18} strokeWidth={2} />
                This invoice was voided by the issuer.
              </div>
            )}
          </div>
        </GlassCard>

        {/* Share / footer */}
        <div className="mt-4 flex items-center justify-center">
          <button
            type="button"
            onClick={copyLink}
            className="inline-flex items-center gap-2 rounded-[6px] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--color-accent)] transition-colors hover:text-[var(--color-fg)]"
          >
            <HugeiconsIcon icon={Copy01Icon} size={14} strokeWidth={2} />
            {copied ? "Link copied" : "Copy invoice link"}
          </button>
        </div>
        <p className="mt-5 text-center font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--color-fg-dim)]">
          Powered by{" "}
          <Link href="/" className="text-[var(--color-accent)] underline-offset-2 hover:underline">
            Talise
          </Link>{" "}
        , money that moves like a message.
        </p>
      </div>
    </main>
  );
}
