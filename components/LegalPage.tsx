import Link from "next/link";
import type { ReactNode } from "react";
import { Diamond } from "@/components/Diamond";

/**
 * Shared shell for the public legal pages (/privacy, /terms).
 *
 * Server-rendered marketing surface in the landing-mint visual language:
 * talise wordmark header, a single readable prose column, and a slim
 * footer that cross-links the two legal documents. Content is passed in
 * as <LegalSection> blocks so both pages stay consistent.
 */
export function LegalPage({
  eyebrow,
  title,
  updated,
  children,
}: {
  eyebrow: string;
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="bp-page relative min-h-screen overflow-hidden">
      <div className="bp-frame flex min-h-screen flex-col" style={{ maxWidth: 840 }}>
        <span aria-hidden className="bp-tick bp-tick-tl" />
        <span aria-hidden className="bp-tick bp-tick-tr" />
        <span aria-hidden className="bp-tick bp-tick-bl" />
        <span aria-hidden className="bp-tick bp-tick-br" />

        <header className="flex items-center justify-between border-b border-[var(--color-line)] px-6 py-5 sm:px-10">
          <Link href="/" className="flex items-center gap-2.5 text-[17px] tracking-[-0.02em] text-[var(--color-fg)]">
            <Diamond />
            <span>talise</span>
          </Link>
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-accent)]">Legal</span>
        </header>

        <main className="flex-1 px-6 pb-24 pt-12 sm:px-10">
          <span className="bp-kicker">{eyebrow}</span>
          <h1 className="mt-5 text-[clamp(32px,5vw,48px)] leading-[1.05]">{title}</h1>
          <p className="mt-3 font-mono text-[12px] text-[var(--color-fg-dim)]">{updated}</p>
          <div className="mt-12 space-y-10">{children}</div>
        </main>

        <footer className="px-6 pb-10 sm:px-10">
          <div className="flex flex-col items-start gap-3 border-t border-[var(--color-line)] pt-6 font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)] sm:flex-row sm:items-center sm:justify-between">
            <span>© {new Date().getFullYear()} Talise · Built on Sui</span>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <Link href="/" className="hover:text-[var(--color-fg)]">Home</Link>
              <Link href="/privacy" className="hover:text-[var(--color-fg)]">Privacy</Link>
              <Link href="/terms" className="hover:text-[var(--color-fg)]">Terms</Link>
              <a href="mailto:team@talise.io" className="hover:text-[var(--color-fg)]">team@talise.io</a>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

export function LegalSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="text-[20px] font-medium tracking-[-0.02em] text-[var(--color-fg)]">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-[15px] leading-[1.65] text-[var(--color-fg-muted)] [&_strong]:font-medium [&_strong]:text-[var(--color-fg)]">
        {children}
      </div>
    </section>
  );
}

export function LegalList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-2 pl-1">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span
            className="mt-[8px] size-1.5 shrink-0 bg-[var(--color-accent)]"
            aria-hidden
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
