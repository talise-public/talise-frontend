"use client";

/**
 * Identity card, the user's payable name. If they've claimed a Talise handle
 * we show "@name" prominently; otherwise a "Claim your @name" CTA that links to
 * the username flow in Settings. Footer carries the brand promise:
 * "$0.00 fee · money lands instantly". Mirrors the iOS usernameCard.
 */

import { useState } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { GlassCard, useToast, type Me } from "@/components/app";

export function IdentityCard({ me }: { me: Me | null }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const address = me?.suiAddress ?? "";
  const short = address ? `${address.slice(0, 8)}…${address.slice(-6)}` : "-";
  const handle = me?.taliseHandle ?? null;

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      toast("Address copied", "success");
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast("Couldn't copy address", "danger");
    }
  }

  return (
    <GlassCard className="flex min-h-[180px] flex-col p-7 md:p-9">
      <div className="flex items-start justify-between gap-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
          Your money lands here
        </span>
        <span
          className="flex size-6 items-center justify-center rounded-full"
          style={{ background: "#CAFFB8" }}
          aria-hidden
        >
          <span className="size-2 rounded-full" style={{ background: "#3d7a29" }} />
        </span>
      </div>

      {handle ? (
        <div className="mt-5 flex-1">
          <div
            className="font-[500] text-[#15300c]"
            style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif', fontSize: 26, letterSpacing: "-0.05em", lineHeight: 1.1 }}
          >
            {handle}@talise
          </div>
          <p className="mt-1.5 text-[13px] text-[#3a5230]">
            Friends can send you USDsui by name.
          </p>
        </div>
      ) : (
        <Link
          href="/app/settings#username"
          className="group mt-5 flex-1"
        >
          <div
            className="font-[500] text-[#15300c] transition-colors group-hover:text-[#3d7a29]"
            style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif', fontSize: 24, letterSpacing: "-0.05em", lineHeight: 1.12 }}
          >
            Claim your @name
          </div>
          <p className="mt-1.5 inline-flex items-center gap-1 text-[13px] text-[#3a5230]">
            So friends can send you USDsui by name.
            <HugeiconsIcon
              icon={ArrowUpRight01Icon}
              size={13}
              strokeWidth={2.2}
              color="#3d7a29"
            />
          </p>
        </Link>
      )}

      <div className="mt-6 flex items-center justify-between gap-3 border-t border-[#15300c]/10 pt-4">
        <button
          type="button"
          onClick={copyAddress}
          disabled={!address}
          className="group inline-flex min-w-0 items-center gap-2 disabled:opacity-50"
        >
          <span className="truncate font-mono text-[11px] text-[#3a5230]">{short}</span>
          <HugeiconsIcon
            icon={copied ? Tick02Icon : Copy01Icon}
            size={14}
            strokeWidth={2}
            color={copied ? "#3d7a29" : undefined}
            className={copied ? "" : "text-[#3d7a29] transition-colors group-hover:text-[#3a5230]"}
          />
        </button>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.16em] text-[#3d7a29]">
          Settles in seconds
        </span>
      </div>
    </GlassCard>
  );
}
