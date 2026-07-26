"use client";

import type { ReactNode } from "react";
import { Diamond } from "@/components/Diamond";

export type PerpsUser = { name: string | null; picture: string | null };

/**
 * Dedicated chrome for the standalone /perps surface (perps.talise.io), a
 * focused trading header instead of the full app nav, so the terminal gets the
 * whole viewport. Editorial "talise / Perps [beta]" lockup, a link back to the
 * wallet, and the account initial.
 */
export function PerpsChrome({ me, children }: { me: PerpsUser; children: ReactNode }) {
  const initial = (me.name?.trim()?.[0] ?? "T").toUpperCase();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b border-[var(--color-line)] bg-[#edf0ea]/85 px-4 backdrop-blur-md lg:px-8">
        <a href="/perps" className="flex items-center gap-2.5" aria-label="Talise Perps">
          <Diamond />
          <span className="text-[18px] font-[500] leading-none tracking-[-0.05em]" style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif' }}>talise</span>
          <span className="text-[var(--color-fg-dim)]">/</span>
          <span className="font-mono text-[13px] uppercase leading-none tracking-[0.06em] text-[var(--color-fg-muted)]">Perps</span>
          <span className="bg-[var(--color-accent-light)] px-2 py-[3px] font-mono text-[9.5px] uppercase leading-none tracking-[0.08em] text-[#1c3d12]">beta</span>
        </a>
        <div className="flex items-center gap-3">
          <a
            href="/app"
            className="hidden items-center gap-1.5 rounded-[6px] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-2)] sm:flex"
          >
            Wallet
            <span aria-hidden>↗</span>
          </a>
          <span
            className="flex size-9 items-center justify-center overflow-hidden rounded-[8px] bg-[#15300c] text-[14px] font-bold text-white"
            aria-label={me.name ?? "Account"}
          >
            {me.picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={me.picture} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />
            ) : (
              initial
            )}
          </span>
        </div>
      </header>
      <main className="w-full flex-1 px-4 pb-10 pt-[4.75rem] lg:px-6">
        {children}
      </main>
    </div>
  );
}
