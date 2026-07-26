"use client";

/**
 * Home, the Talise dashboard, Wise-clean.
 *
 * Leads with the balance on the canvas (not in a card), then the primary money
 * actions as pills, then two tiles (your payable identity + a "do more" Earn
 * nudge), then recent activity. Single stacked column on mobile; the two tiles
 * sit side-by-side on lg.
 *
 * The shell (app/app/layout.tsx) mounts the providers + chrome; this page only
 * renders content inside <main>. `me` comes from useMe(); balances/activity
 * refresh on the global `talise:tx` event.
 */

import { useMe } from "@/components/app";
import {
  BalanceHero,
  SecondaryActions,
  DoMoreCard,
  RecentActivity,
} from "@/components/app/home";

export default function HomePage() {
  const { me } = useMe();
  const first = (me?.name ?? "").trim().split(/\s+/)[0];

  return (
    <div className="space-y-8">
      {/* Perps launch banner → the dedicated perps.talise.io terminal. */}
      <a
        href="https://perps.talise.io"
        className="group flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 rounded-[10px] border border-[var(--color-line)] bg-[var(--color-accent-light)] px-4 py-2.5 text-center text-[#1c3d12] transition-colors hover:bg-[#bcf2a2]"
      >
        <span className="bg-[#1c3d12] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--color-accent-light)] sm:text-[9.5px]">New</span>
        <span className="text-[13px] font-[500] sm:text-[14px]" style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}>
          You can now trade perps on talise 🎉
        </span>
        <span aria-hidden className="font-mono text-[12px] transition-transform group-hover:translate-x-0.5">→</span>
      </a>

      <div className="space-y-2.5">
        {/* Greeting, quiet, personal, hugging the balance card (it used to
            float a full space-y-8 above it, stranded under the header). */}
        {first ? (
          <p className="text-[13px] text-[#3d7a29]">Welcome back, {first}.</p>
        ) : null}

        {/* The lead: one calm balance card (eyebrow → balance → identity row →
            Send/Request inline). The remaining quick actions sit in a compact
            secondary row just beneath it. The card carries identity, so the old
            standalone identity card is gone. On lg the card pairs with the
            do-more tile so the row still reads intentional on desktop. */}
        {/* Flat grid: the two CARDS are direct siblings on row one, so
            items-stretch makes them EXACTLY equal height; the secondary pills
            span the full width underneath on desktop. On mobile the order
            stays balance → pills → do-more (order utilities). */}
        <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-2 lg:items-stretch">
          <div className="order-1 h-full lg:order-none">
            <BalanceHero inline me={me} />
          </div>
          <div className="order-3 h-full lg:order-none">
            <DoMoreCard />
          </div>
          <div className="order-2 lg:order-none lg:col-span-2">
            <SecondaryActions me={me} />
          </div>
        </div>
      </div>

      {/* Recent activity. */}
      <RecentActivity />
    </div>
  );
}
