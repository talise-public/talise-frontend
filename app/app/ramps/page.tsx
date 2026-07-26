"use client";

/**
 * /app/ramps, money in & money out.
 *
 * Order is top-up FIRST, cash-out SECOND (the funnel reads in → out). Top-up
 * state comes from ONE runtime source of truth, `GET /api/onramp/config`
 * (driven by `ONRAMP_ENABLED`), rendered by <AddMoneyPanel>. There is NO
 * hard-coded flag in this file: flipping the env var flips the card with no
 * redeploy, and both states are honest — closed points the user at the
 * receive-address path that actually works today, open runs the real Bridge
 * bank-funding flow.
 *
 * Cash-out (off-ramp) is the live action: NGN bank payout, capped server-side
 * ($200/account/day). Queued corridors (KES/GHS) collapse into a single
 * overlapped-flag stack row, greyscaled circles + one "Coming soon" pill.
 */

import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { BankIcon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { StatusPill, useMe } from "@/components/app";
import { Flag } from "@/components/app/ui/Flag";
import { AddMoneyPanel } from "./AddMoneyPanel";

// Off-ramp (cash-out) is OPEN in the web app. Exposure is bounded by the
// server-side daily cap (OFFRAMP_MAX_USD = $200/account/day, enforced on every
// order in lib/linq.ts). Set true to re-lock the cash-out card.
const OFFRAMP_LOCKED = false;
// Per-day cash-out cap, mirrored for a subtle UI note (keep in sync with
// OFFRAMP_MAX_USD in lib/linq.ts, that server value is the real enforcement).
const OFFRAMP_CAP_USD = 200;

/** Queued off-ramp corridors, rendered as one overlapped grey flag stack. */
const COMING_SOON_CORRIDORS: { cc: string; country: string }[] = [
  { cc: "ke", country: "Kenya" },
  { cc: "gh", country: "Ghana" },
  { cc: "id", country: "Indonesia" },
  { cc: "ph", country: "Philippines" },
];

export default function RampsPage() {
  const { me } = useMe();
  // Show the US corridor when the per-user flag is on. In local dev we always
  // surface it so the flow is testable without waiting on the env flag; every
  // US cash-out call is still server-gated (allowlist + KYC), so this only
  // controls whether the row/chooser is visible, never actual access.
  const usdEnabled =
    !!me?.features?.usdWithdrawal || process.env.NODE_ENV === "development";

  return (
    <div className="mx-auto w-full max-w-2xl space-y-7 pb-10 pt-1">
      {/* Hero */}
      <header className="space-y-3">
        <div className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
          Ramps
        </div>
        <h1
          className="max-w-xl text-[clamp(26px,5vw,40px)] font-[500] leading-[1.02] tracking-[-0.05em] text-[#15300c]"
          style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}
        >
          Money in, money out, at the real rate.
        </h1>
        <p className="max-w-md text-[15px] leading-relaxed text-[#3a5230]">
          {/* Short on phones; the fuller line reads on wider screens. */}
          <span className="sm:hidden">Cash out to your bank, settled in under a second.</span>
          <span className="hidden sm:inline">
            Cash out straight to your bank, a live rate, one clear fee,
            settled in under a second.
          </span>
        </p>
      </header>

      {/* TOP-UP (on-ramp), first in the funnel. Self-gating: it asks the server
          whether funding is open and renders the honest state either way. */}
      <AddMoneyPanel />

      {/* CASH-OUT (off-ramp), the live action. */}
      <div
        className="relative flex flex-col overflow-hidden rounded-[28px] bg-[#f7fcf2] p-7 sm:p-9"
        style={{ boxShadow: "0 1px 2px rgba(18,26,15,0.04), 0 14px 34px -22px rgba(18,26,15,0.22)" }}
      >
        <div className="relative flex items-start justify-between gap-3">
          <div className="flex items-center gap-3.5">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-[#CAFFB8] text-[#15300c]">
              <HugeiconsIcon icon={BankIcon} size={20} strokeWidth={1.8} />
            </span>
            <div className="space-y-1">
              <span className="block font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
                Off-ramp
              </span>
              <h2
                className="text-[20px] font-[500] tracking-[-0.05em] text-[#15300c]"
                style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}
              >
                Cash out to your bank
              </h2>
            </div>
          </div>
        </div>

        <ul className="relative mt-6 divide-y divide-[#15300c]/10">
          {/* US corridor (Bridge), shown only when the per-user flag is on. */}
          {usdEnabled && (
            <CorridorRow href="/app/ramps/cashout/us" cc="us" country="United States" cur="USD" />
          )}
          {/* Nigeria, the original live corridor. */}
          {OFFRAMP_LOCKED ? (
            <li className="flex items-center justify-between gap-3 py-3.5 first:pt-0">
              <CorridorLabel cc="ng" country="Nigeria" cur="NGN" />
              <StatusPill label="Coming soon" tone="neutral" />
            </li>
          ) : (
            <CorridorRow href="/app/ramps/cashout/ng" cc="ng" country="Nigeria" cur="NGN" />
          )}
          {/* Queued corridors: one overlapped, greyscaled flag stack. */}
          <li className="flex items-center justify-between gap-3 py-3.5">
            <span className="flex items-center gap-3">
              <span className="flex shrink-0 -space-x-2.5">
                {COMING_SOON_CORRIDORS.map((c) => (
                  <span
                    key={c.cc}
                    className="flex size-7 items-center justify-center overflow-hidden rounded-full opacity-60 ring-2 ring-[#f7fcf2] grayscale"
                  >
                    <Flag code={c.cc} size={28} />
                  </span>
                ))}
              </span>
              <span className="text-[13px] text-[#3d7a29]">
                {COMING_SOON_CORRIDORS.map((c) => c.country).join(", ")} &amp; more
              </span>
            </span>
            <StatusPill label="Coming soon" tone="neutral" />
          </li>
        </ul>

        {!OFFRAMP_LOCKED && (
          <p className="relative mt-6 text-center font-mono text-[11px] text-[#3d7a29]">
            Pick a country to cash out · NGN capped at ${OFFRAMP_CAP_USD}/day while we scale.
          </p>
        )}
      </div>

      <p className="text-center text-[12px] leading-relaxed text-[#3d7a29]">
        Balances are always 1:1 with the US dollar, send and receive anytime.
      </p>
    </div>
  );
}

/** The flag + country + currency label used inside a corridor row. */
function CorridorLabel({ cc, country, cur }: { cc: string; country: string; cur: string }) {
  return (
    <span className="flex items-center gap-3">
      <span className="flex size-7 items-center justify-center overflow-hidden rounded-full ring-1 ring-[#15300c]/10">
        <Flag code={cc} size={28} />
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className="text-[14px] font-medium text-[#15300c]">{country}</span>
        <span className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">{cur}</span>
      </span>
    </span>
  );
}

/** A live, clickable corridor row that navigates to its full cash-out page. */
function CorridorRow({ href, cc, country, cur }: { href: string; cc: string; country: string; cur: string }) {
  return (
    <li>
      <Link
        href={href}
        className="group -mx-2 flex items-center justify-between gap-3 rounded-2xl px-2 py-3.5 transition-colors hover:bg-[#CAFFB8]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3d7a29]/40"
      >
        <CorridorLabel cc={cc} country={country} cur={cur} />
        <span className="flex items-center gap-2">
          <StatusPill label="Live" tone="success" />
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={16}
            strokeWidth={2}
            className="text-[#3d7a29] transition-transform group-hover:translate-x-0.5"
          />
        </span>
      </Link>
    </li>
  );
}
