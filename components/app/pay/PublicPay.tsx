"use client";

/**
 * PublicPay — the standalone, ungated /pay/<handle> page.
 *
 * This is the shareable target of a Talise payment link. It is NOT behind the
 * /app gate, so it can't read the recipient table (that endpoint is authed).
 * Instead it renders the handle + optional amount/memo straight from the URL
 * and offers a single "Pay with Talise" CTA that routes into the app's send
 * flow with the recipient and amount prefilled (`/app/pay?to=&amount=`). If the
 * visitor isn't signed in, the app's send pipeline triggers Google sign-in and
 * returns them to the prefilled review.
 *
 * Self-contained light-mint styling — it lives outside AppShell, so it carries
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
    <main
      className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-5 py-10 text-[#15300c]"
      style={{
        background:
          "radial-gradient(120% 90% at 15% 0%, #e6f9d6 0%, #f7fcf2 45%, #ffeede 100%)",
      }}
    >
      <div className="relative z-10 w-full max-w-sm">
        {/* Brand mark */}
        <div className="mb-8 flex justify-center">
          <Link href="/" className="inline-flex items-center gap-2">
            <Diamond />
            <span
              className="text-[18px] font-[800] lowercase tracking-[-0.03em] text-[#15300c]"
              style={{ fontFamily: "var(--font-display-v2)" }}
            >
              talise
            </span>
          </Link>
        </div>

        {/* Pay card — light bento */}
        <div
          className="rounded-[28px] bg-[#f7fcf2] px-6 py-7 text-center"
          style={{ boxShadow: "10px 10px 0 #15300c" }}
        >
          {/* Label chip */}
          <span className="inline-block rounded-full border border-[#15300c]/15 bg-white/60 px-3 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[#3d7a29] backdrop-blur-sm">
            {amountLabel ? "Payment request" : "Pay"}
          </span>

          {/* Amount or handle */}
          {amountLabel ? (
            <div
              className="mt-4 font-[800] tabular-nums text-[#15300c]"
              style={{ fontFamily: "var(--font-display-v2)", fontSize: 44, letterSpacing: "-0.04em", lineHeight: 1 }}
            >
              {amountLabel}
            </div>
          ) : (
            <div
              className="mt-4 text-[26px] font-[800] text-[#15300c]"
              style={{ fontFamily: "var(--font-display-v2)", letterSpacing: "-0.02em" }}
            >
              {displayName(slug)}
            </div>
          )}

          {/* Recipient sublabel when amount is shown */}
          {amountLabel && (
            <p className="mt-2 text-[14px] text-[#3a5230]">
              to <span className="font-medium text-[#15300c]">{displayName(slug)}</span>
            </p>
          )}

          {/* Memo */}
          {memo && (
            <p className="mx-auto mt-2 max-w-[15rem] text-[13px] text-[#3d7a29]">
              &ldquo;{memo}&rdquo;
            </p>
          )}

          {/* Token sublabel */}
          {amountLabel && (
            <p className="mt-1.5 font-mono text-[11px] text-[#3d7a29]">
              {amountUsd!.toFixed(2)} USDsui · digital dollars, 1:1
            </p>
          )}

          {/* Divider */}
          <div className="my-5 border-t border-[#15300c]/10" />

          {/* Primary CTA */}
          <Link
            href={target}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#15300c] px-6 py-3.5 text-[15px] font-semibold text-[#f7fcf2] transition-transform duration-150 hover:-translate-y-0.5 active:scale-[0.98]"
          >
            Pay with Talise
            <HugeiconsIcon icon={ArrowRight01Icon} size={18} strokeWidth={2.4} color="#f7fcf2" />
          </Link>

          <button
            type="button"
            onClick={copyLink}
            className="mt-3 inline-flex items-center justify-center gap-1.5 text-[13px] font-medium text-[#3d7a29] transition-colors hover:text-[#15300c]"
          >
            <HugeiconsIcon
              icon={copied ? Tick02Icon : Copy01Icon}
              size={14}
              strokeWidth={2}
              color={copied ? "#3d7a29" : undefined}
            />
            {copied ? "Link copied" : "Copy link"}
          </button>
        </div>

        {/* Trust footnote */}
        <div className="mt-5 flex items-center justify-center gap-1.5">
          <HugeiconsIcon
            icon={CheckmarkBadge01Icon}
            size={13}
            color="#3d7a29"
            strokeWidth={2}
          />
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#3d7a29]">
            Gasless · settles on Sui in seconds
          </span>
        </div>

        <p className="mt-4 text-center text-[12px] text-[#3d7a29]">
          New to Talise?{" "}
          <Link href="/" className="text-[#3a5230] underline-offset-2 hover:underline">
            See how it works
          </Link>
        </p>
      </div>
    </main>
  );
}

export default PublicPay;
