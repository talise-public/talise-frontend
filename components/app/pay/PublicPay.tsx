"use client";

/**
 * PublicPay, the standalone, ungated /pay/<handle> page.
 *
 * This is the shareable target of a Talise payment link. It is NOT behind the
 * /app gate, so it can't read the recipient table (that endpoint is authed).
 * Instead it renders the handle + optional amount/memo straight from the URL
 * and offers a single "Pay with Talise" CTA that routes into the app's send
 * flow with the recipient and amount prefilled (`/app/pay?to=&amount=`). If the
 * visitor isn't signed in, the app's send pipeline triggers Google sign-in and
 * returns them to the prefilled review.
 *
 * Self-contained light-mint styling, it lives outside AppShell, so it carries
 * its own `.landing-mint` root (flips tokens + reskins `.talise-glass` to the
 * white lifted card) and can't rely on the shell's providers (no useCurrency
 * here). Amounts are shown in USD.
 */

import { useState } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  CheckmarkBadge01Icon,
  Copy01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Diamond } from "@/components/Diamond";

export type PublicPayProps = {
  /** The raw handle or address slug from the URL path. */
  slug: string;
  /** Optional requested amount in USD. */
  amountUsd: number | null;
  /** Optional memo. */
  memo: string | null;
};

function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{6,}$/.test(s);
}

function displayName(slug: string): string {
  if (isAddress(slug)) return `${slug.slice(0, 8)}…${slug.slice(-6)}`;
  // Talise handles read as "name@talise" so they can't be confused with a
  // SuiNS ".sui" name. (The pay-link slug/URL itself stays /pay/<handle>.)
  return `${slug.replace(/^@/, "")}@talise`;
}

export function PublicPay({ slug, amountUsd, memo }: PublicPayProps) {
  const [copied, setCopied] = useState(false);

  // Route into the in-app send flow with the recipient (+ amount) prefilled.
  const target = (() => {
    const qs = new URLSearchParams();
    qs.set("to", slug);
    if (amountUsd != null) qs.set("amount", amountUsd.toFixed(2));
    return `/app/pay?${qs.toString()}`;
  })();

  const amountLabel =
    amountUsd != null
      ? `$${amountUsd.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`
      : null;

  const copyLink = async () => {
    if (typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <main className="bp-page relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-5 py-10">
      <div className="bp-frame flex min-h-screen w-full flex-col items-center justify-center" style={{ maxWidth: 520 }}>
        <span aria-hidden className="bp-tick bp-tick-tl" />
        <span aria-hidden className="bp-tick bp-tick-tr" />
        <span aria-hidden className="bp-tick bp-tick-bl" />
        <span aria-hidden className="bp-tick bp-tick-br" />

        <div className="relative z-10 w-full max-w-sm px-4">
          {/* Brand mark */}
          <div className="mb-8 flex justify-center">
            <Link href="/" className="inline-flex items-center gap-2 text-[var(--color-fg)]">
              <Diamond />
              <span
                className="text-[18px] lowercase tracking-[-0.03em]"
                style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif', fontWeight: 500 }}
              >
                talise
              </span>
            </Link>
          </div>

          {/* Pay card, rectangular hairline */}
          <div className="bp-card px-6 py-7 text-center">
            {/* Label chip */}
            <span className="inline-block rounded-[6px] border border-[var(--color-line)] bg-[var(--color-accent-soft)] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-accent)]">
              {amountLabel ? "Payment request" : "Pay"}
            </span>

            {/* Amount or handle */}
            {amountLabel ? (
              <div
                className="mt-4 tabular-nums text-[var(--color-fg)]"
                style={{ fontFamily: '"Google Sans Variable", var(--font-sans-v2), system-ui, sans-serif', fontSize: 44, letterSpacing: "-0.02em", lineHeight: 1, fontWeight: 500 }}
              >
                {amountLabel}
              </div>
            ) : (
              <div
                className="mt-4 text-[26px] text-[var(--color-fg)]"
                style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif', letterSpacing: "-0.03em", fontWeight: 500 }}
              >
                {displayName(slug)}
              </div>
            )}

            {/* Recipient sublabel when amount is shown */}
            {amountLabel && (
              <p className="mt-2 text-[14px] text-[var(--color-fg-muted)]">
                to <span className="font-medium text-[var(--color-fg)]">{displayName(slug)}</span>
              </p>
            )}

            {/* Memo */}
            {memo && (
              <p className="mx-auto mt-2 max-w-[15rem] text-[13px] text-[var(--color-fg-muted)]">
                &ldquo;{memo}&rdquo;
              </p>
            )}

            {/* Token sublabel */}
            {amountLabel && (
              <p className="mt-1.5 font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-accent)]">
                {amountUsd!.toFixed(2)} USDsui · digital dollars, 1:1
              </p>
            )}

            {/* Divider */}
            <div className="my-5 border-t border-[var(--color-line)]" />

            {/* Primary CTA */}
            <Link
              href={target}
              className="inline-flex w-full items-center justify-center gap-2 rounded-[8px] bg-[var(--color-accent-deep)] px-6 py-3.5 font-mono text-[13px] uppercase tracking-[0.1em] text-white transition-transform duration-150 hover:-translate-y-0.5 active:scale-[0.98]"
            >
              Pay with Talise
              <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2.4} color="#ffffff" />
            </Link>

            <button
              type="button"
              onClick={copyLink}
              className="mt-3 inline-flex items-center justify-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--color-fg-dim)] transition-colors hover:text-[var(--color-fg)]"
            >
              <HugeiconsIcon
                icon={copied ? Tick02Icon : Copy01Icon}
                size={13}
                strokeWidth={2}
                color={copied ? "currentColor" : undefined}
              />
              {copied ? "Link copied" : "Copy link"}
            </button>
          </div>

          {/* Trust footnote */}
          <div className="mt-5 flex items-center justify-center gap-1.5">
            <HugeiconsIcon
              icon={CheckmarkBadge01Icon}
              size={13}
              color="var(--color-accent)"
              strokeWidth={2}
            />
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-accent)]">
              Gasless · settles on Sui in seconds
            </span>
          </div>

          <p className="mt-4 text-center font-mono text-[11px] text-[var(--color-fg-dim)]">
            New to Talise?{" "}
            <Link href="/" className="text-[var(--color-accent)] underline-offset-2 hover:underline">
              See how it works
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}

export default PublicPay;
