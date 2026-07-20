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
import {
  GlassCard,
  PrimaryButton,
  StatusPill,
  Eyebrow,
  MicroLabel,
  QrImage,
} from "@/components/app";
import { Diamond } from "@/components/Diamond";

type PublicRequest = {
  id: string;
  amountUsd: number;
  currency: string;
  requesterNote: string | null;
  note: string | null;
  status: "open" | "paid" | "cancelled" | "expired";
  expiresAt: number | null;
  createdAt: number;
  payDigest?: string | null;
  paidAt?: number | null;
};

type Requester = { display: string; address: string };

export type RequestPayViewProps = {
  request: PublicRequest;
  requester: Requester;
  origin: string;
};

/**
 * The public payment-request page body. Mirrors InvoicePayView's classic
 * light-mint document treatment, inverted for a REQUEST: a big "Payment
 * request" heading with the requester underneath, the amount due, an optional
 * note, a scannable QR of the share link, and a single "Pay" CTA that
 * deep-links into /app/pay with the amount + recipient prefilled. Standalone
 * (no AppShell / CurrencyProvider) so it formats its own currency locally.
 */
export function RequestPayView({ request, requester, origin }: RequestPayViewProps) {
  const [copied, setCopied] = useState(false);

  // The request is stored in USD (USDsui); display it in its denominated
  // currency via the live FX rate. Public page (no CurrencyProvider) → it
  // fetches the open /api/fx feed itself.
  const [rate, setRate] = useState(1);
  useEffect(() => {
    if (request.currency === "USD") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/fx");
        if (!res.ok) return;
        const data = (await res.json()) as { rates?: Record<string, number> };
        const r = data?.rates?.[request.currency];
        if (!cancelled && typeof r === "number" && r > 0) setRate(r);
      } catch {
        /* keep 1:1, better than a broken figure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request.currency]);

  const fmt = useMemo(() => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: request.currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } catch {
      return new Intl.NumberFormat(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }
  }, [request.currency]);

  // `money` takes a USD figure and renders it in the request's currency.
  const money = (usd: number) => fmt.format(usd * rate);

  const shareUrl = `${origin}/req/${request.id}`;

  // The pay link carries the USD amount (SendFlow re-displays it in the payer's
  // currency); keep full precision so sub-dollar requests don't round away.
  const payHref = `/app/pay?to=${encodeURIComponent(requester.address)}&amount=${encodeURIComponent(
    request.amountUsd.toFixed(6)
  )}&request=${encodeURIComponent(request.id)}`;

  const statusTone =
    request.status === "paid"
      ? "completed"
      : request.status === "open"
        ? "pending"
        : "danger";
  const statusLabel =
    request.status === "paid"
      ? "Paid"
      : request.status === "open"
        ? "Awaiting payment"
        : request.status === "expired"
          ? "Expired"
          : "Cancelled";

  const createdLabel = new Date(request.createdAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const expiresLabel =
    request.expiresAt != null
      ? new Date(request.expiresAt).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : null;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked, silently ignore */
    }
  };

  // The note shown on the page: prefer the decrypted private note, fall back to
  // the public label/memo.
  const noteText = request.note || request.requesterNote;

  return (
    <main className="bp-page relative min-h-dvh overflow-hidden px-5 py-10 sm:py-16">
      <div className="bp-frame relative mx-auto flex min-h-full w-full flex-col" style={{ maxWidth: 640 }}>
        <span aria-hidden className="bp-tick bp-tick-tl" />
        <span aria-hidden className="bp-tick bp-tick-tr" />
        <span aria-hidden className="bp-tick bp-tick-bl" />
        <span aria-hidden className="bp-tick bp-tick-br" />

        <div className="relative z-10 mx-auto w-full max-w-xl px-4">
        {/* Brand row */}
        <div className="mb-6 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 text-[var(--color-fg)]">
            <Diamond />
            <span
              className="text-[18px] lowercase tracking-[-0.03em]"
              style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif', fontWeight: 500 }}
            >
              talise
            </span>
          </Link>
          <StatusPill label={statusLabel} tone={statusTone} />
        </div>

        <GlassCard className="overflow-hidden p-0">
          {/* Diagonal status stamp for settled / closed requests. */}
          {request.status !== "open" && (
            <div
              className="pointer-events-none absolute right-5 top-6 z-10 select-none sm:right-8"
              aria-hidden
            >
              <span
                className="inline-block -rotate-12 rounded-[6px] border-2 px-3 py-1 font-mono text-[16px] font-bold uppercase opacity-45 sm:text-[18px]"
                style={{
                  letterSpacing: "0.28em",
                  color: request.status === "paid" ? "var(--color-accent)" : "#c0532f",
                  borderColor: request.status === "paid" ? "var(--color-accent)" : "#c0532f",
                }}
              >
                {request.status === "paid" ? "Paid" : request.status === "expired" ? "Expired" : "Void"}
              </span>
            </div>
          )}

          {/* Document header, big heading, requester underneath */}
          <div className="px-5 pb-6 pt-7 sm:px-8">
            <h1
              className="text-[34px] uppercase leading-none tracking-[-0.02em] text-[var(--color-fg)] sm:text-[40px]"
              style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif', fontWeight: 500 }}
            >
              Payment request
            </h1>
            <p className="mt-2.5 text-[15px] font-medium text-[var(--color-fg)]">
              {requester.display} is requesting a payment
            </p>

            {/* Amount, the headline figure */}
            <div className="mt-6">
              <Eyebrow>Amount requested</Eyebrow>
              <p
                className="mt-1 text-[40px] leading-none text-[var(--color-fg)]"
                style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif', fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em", fontWeight: 500 }}
              >
                {money(request.amountUsd)}
              </p>
              {request.currency !== "USD" && (
                <p className="mt-1.5 font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-accent)]">
                  Settles as {request.amountUsd.toFixed(2)} USDsui · 1:1 USD
                </p>
              )}
            </div>

            {/* Meta, date / request no / expiry */}
            <dl className="mt-6 space-y-1.5 text-[13px]">
              <div className="flex gap-2">
                <dt className="w-[88px] shrink-0 font-mono text-[10px] font-medium uppercase leading-[1.7] tracking-wider text-[var(--color-accent)]">
                  Created
                </dt>
                <dd className="text-[var(--color-fg)]">{createdLabel}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-[88px] shrink-0 font-mono text-[10px] font-medium uppercase leading-[1.7] tracking-wider text-[var(--color-accent)]">
                  Request no.
                </dt>
                <dd className="break-all font-mono text-[12px] leading-[1.6] text-[var(--color-fg-muted)]">
                  {request.id}
                </dd>
              </div>
              {expiresLabel && (
                <div className="flex gap-2">
                  <dt className="w-[88px] shrink-0 font-mono text-[10px] font-medium uppercase leading-[1.7] tracking-wider text-[var(--color-accent)]">
                    Expires
                  </dt>
                  <dd className="text-[var(--color-fg)]">{expiresLabel}</dd>
                </div>
              )}
            </dl>

            {/* Note from the requester */}
            {noteText && (
              <div className="mt-6 border-t border-[var(--color-line)] pt-5">
                <Eyebrow>Note</Eyebrow>
                <p className="mt-1.5 whitespace-pre-wrap text-[14px] text-[var(--color-fg-muted)]">{noteText}</p>
              </div>
            )}
          </div>

          {/* Pay CTA / status block */}
          <div className="border-t border-[var(--color-line)] px-5 py-5 sm:px-8">
            {request.status === "open" ? (
              <>
                <PrimaryButton href={payHref} full>
                  <HugeiconsIcon icon={ArrowRight02Icon} size={18} strokeWidth={2} />
                  Pay {money(request.amountUsd)}
                </PrimaryButton>
                <p className="mt-3 text-center font-mono text-[11px] text-[var(--color-fg-dim)]">
                  Sign in with Google to pay, no gas, no wallet setup. Money moves as USDsui.
                </p>

                {/* Scan-to-pay QR, share-friendly on any phone. */}
                <div className="mt-6 flex flex-col items-center gap-3 border-t border-[var(--color-line)] pt-6">
                  <MicroLabel>Scan to open this request</MicroLabel>
                  <QrImage value={shareUrl} size={180} />
                </div>
              </>
            ) : request.status === "paid" ? (
              <div className="space-y-3">
                <div className="flex items-center justify-center gap-2 rounded-[10px] bg-[var(--color-accent-light)] py-3 text-[14px] text-[#1c3d12]">
                  <HugeiconsIcon icon={CheckmarkCircle02Icon} size={18} strokeWidth={2} />
                  Paid
                  {request.paidAt
                    ? ` · ${new Date(request.paidAt).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}`
                    : ""}
                  . Thank you.
                </div>
                {request.payDigest && (
                  <div className="rounded-[10px] border border-[var(--color-line)] px-4 py-3.5">
                    <MicroLabel>On-chain receipt</MicroLabel>
                    <a
                      href={`https://suiscan.xyz/mainnet/tx/${request.payDigest}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-1.5 block break-all font-mono text-[12px] text-[var(--color-accent)] underline-offset-2 hover:underline"
                    >
                      {request.payDigest}
                    </a>
                    <p className="mt-1.5 font-mono text-[11px] text-[var(--color-fg-dim)]">
                      Settled on Sui, verify this payment on-chain.
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-center gap-2 rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface-2)] py-3 text-[14px] text-[var(--color-fg-muted)]">
                <HugeiconsIcon icon={Cancel01Icon} size={18} strokeWidth={2} />
                {request.status === "expired"
                  ? "This request has expired."
                  : "This request was cancelled by the requester."}
              </div>
            )}
          </div>
        </GlassCard>

        {/* Share / footer */}
        <div className="mt-4 flex items-center justify-center">
          <button
            type="button"
            onClick={copyLink}
            className="inline-flex items-center gap-2 rounded-[6px] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-fg-dim)] transition-colors hover:text-[var(--color-fg)]"
          >
            <HugeiconsIcon icon={Copy01Icon} size={14} strokeWidth={2} />
            {copied ? "Link copied" : "Copy request link"}
          </button>
        </div>
        <p className="mt-5 text-center font-mono text-[11px] text-[var(--color-fg-dim)]">
          Powered by{" "}
          <Link href="/" className="text-[var(--color-accent)] underline-offset-2 hover:underline">
            Talise
          </Link>{" "}
        , money that moves like a message.
        </p>
        </div>
      </div>
    </main>
  );
}
