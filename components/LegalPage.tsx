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
    <div className="landing-mint relative min-h-screen overflow-hidden text-[var(--color-fg)]">
      <div className="talise-top-glow" aria-hidden />

      <header className="relative z-10 mx-auto flex w-full max-w-[1440px] items-center justify-between px-6 py-5 md:px-12 lg:px-16">
        <Link
          href="/"
          className="flex items-center gap-2.5 text-[17px] tracking-tight text-[var(--color-fg)]"
        >
          <Diamond />
          <span>talise</span>
        </Link>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-[720px] px-6 pb-24 pt-10 md:pt-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-accent-deep)]">
          {eyebrow}
        </p>
        <h1 className="mt-3 text-[clamp(32px,5vw,48px)] font-medium leading-[1.06] tracking-[-0.03em]">
          {title}
        </h1>
        <p className="mt-3 text-[13px] text-[var(--color-fg-dim)]">{updated}</p>

        <div className="mt-10 space-y-10">{children}</div>
      </main>

      <footer className="relative z-10 mx-auto w-full max-w-[720px] px-6 pb-10">
        <div className="flex flex-col items-start gap-3 border-t border-[var(--color-line)] pt-6 text-[12px] text-[var(--color-fg-dim)] sm:flex-row sm:items-center sm:justify-between">
          <span>© {new Date().getFullYear()} Talise · Built on Sui.</span>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Link href="/" className="hover:text-[var(--color-fg)]">
              Home
            </Link>
            <Link href="/privacy" className="hover:text-[var(--color-fg)]">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-[var(--color-fg)]">
              Terms
            </Link>
            <a href="mailto:team@talise.io" className="hover:text-[var(--color-fg)]">
              team@talise.io
            </a>
          </div>
        </div>
      </footer>
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
            className="mt-[9px] size-1.5 shrink-0 rounded-full bg-[var(--color-accent-deep)]"
            aria-hidden
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
