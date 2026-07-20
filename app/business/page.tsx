import Link from "next/link";
import Image from "next/image";
import type { ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  UserGroupIcon,
  SentIcon,
  Invoice01Icon,
  Briefcase01Icon,
  GoogleIcon,
  BankIcon,
  FlashIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Diamond } from "@/components/Diamond";

export const dynamic = "force-dynamic";

/**
 * /business, the Talise for Business landing page.
 *
 * A chrome-free marketing surface (no AppShell) that sits under the /business
 * admin gate for now. Rendered in the engineering-blueprint (.bp-page)
 * visual language, construction frame, corner ticks, Everett headings, with
 * a split hero and a B2B story: streaming payroll, batch payouts, invoices &
 * links, work contracts, gasless, settled on Sui. CTAs route to
 * /business/dashboard (the workspace) and /waitlist.
 */
export default function BusinessLanding() {
  return (
    <div className="bp-page relative min-h-screen overflow-hidden">
      <div className="bp-frame relative flex min-h-screen flex-col" style={{ maxWidth: 1200 }}>
        <span aria-hidden className="bp-tick bp-tick-tl" />
        <span aria-hidden className="bp-tick bp-tick-tr" />
        <span aria-hidden className="bp-tick bp-tick-bl" />
        <span aria-hidden className="bp-tick bp-tick-br" />

        <BizTopBar />

        <main className="flex-1 px-6 pb-28 pt-2 md:px-10">
          <Hero />
          <FeatureGrid />
          <HowItWorks />
          <FinalCta />
        </main>

        <SiteFooter />
      </div>
    </div>
  );
}

// ── Top bar ──────────────────────────────────────────────────────────────────

function BizTopBar() {
  return (
    <header className="flex items-center justify-between border-b border-[var(--color-line)] px-6 py-5 md:px-10">
      <Link href="/" className="flex items-center gap-2.5 text-[17px] tracking-[-0.02em] text-[var(--color-fg)]">
        <Diamond />
        <span>talise</span>
        <span className="ml-1 rounded-[6px] border border-[var(--color-line)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-dim)]">
          for business
        </span>
      </Link>
      <Link
        href="/business/dashboard"
        className="inline-flex h-9 items-center rounded-[8px] bg-[var(--color-accent-deep)] px-4 font-mono text-[12px] uppercase tracking-[0.06em] text-white transition-colors hover:bg-[#256016] sm:px-5"
      >
        Open dashboard
      </Link>
    </header>
  );
}

// ── Hero (split: copy left, product right) ─────────────────────────────────────

function Hero() {
  return (
    <section className="grid items-center gap-10 pt-8 md:pt-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12">
      {/* Left, copy */}
      <div className="text-center lg:text-left">
        <span className="bp-kicker mx-auto lg:mx-0">Built on Sui · 0 gas fees</span>

        <h1 className="mt-5 text-[clamp(40px,6.2vw,76px)] leading-[1.02] text-[var(--color-fg)]">
          Pay your team.
          <br />
          Bill the world.
          <br />
          <span className="text-[var(--color-accent)]">Gasless.</span>
        </h1>

        <p className="mx-auto mt-6 max-w-[520px] font-mono text-[14px] leading-[1.6] text-[var(--color-fg-muted)] lg:mx-0">
          One account for streaming payroll, batch payouts, invoices, and
          payment links, settled on Sui in about a second, in digital dollars.
          Your team and clients sign in with Google; the chain stays invisible.
        </p>

        <div className="mx-auto mt-8 flex w-full max-w-[320px] flex-col items-stretch gap-2.5 sm:max-w-none sm:flex-row sm:items-center lg:justify-start sm:justify-center">
          <Link
            href="/business/dashboard"
            className="inline-flex h-12 w-full items-center justify-center rounded-[8px] bg-[var(--color-accent-deep)] px-7 font-mono text-[13px] uppercase tracking-[0.06em] text-white transition-colors hover:bg-[#256016] sm:w-auto"
          >
            Open dashboard
          </Link>
          <Link
            href="https://www.talise.io/waitlist"
            className="inline-flex h-12 w-full items-center justify-center rounded-[8px] border border-[var(--color-line)] bg-[var(--color-surface)] px-7 font-mono text-[13px] uppercase tracking-[0.06em] text-[var(--color-fg)] transition-colors hover:border-[var(--color-accent-deep)] hover:text-[var(--color-accent-deep)] sm:w-auto"
          >
            Join the waitlist
          </Link>
        </div>

        {/* Honest trust line, Sui network scale, not invented Talise metrics. */}
        <p className="mx-auto mt-6 max-w-[480px] font-mono text-[12px] text-[var(--color-fg-dim)] lg:mx-0">
          Built on the rails settling{" "}
          <span className="text-[var(--color-fg-muted)]">$100B+ in stablecoin transfers a month</span>{" "}
          on Sui.
        </p>
      </div>

      {/* Right, product visual in a hairline frame */}
      <div className="relative">
        <div className="bp-card overflow-hidden p-3 sm:p-4">
          <div className="relative aspect-[5/4] w-full overflow-hidden rounded-[8px]">
            <Image
              src="/talise-app-collage.png"
              alt="The Talise business app, balance, payouts, and invoices"
              fill
              priority
              sizes="(max-width: 1024px) 100vw, 600px"
              className="object-contain"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Feature grid, the B2B capabilities ────────────────────────────────────────

const FEATURES: { icon: IconSvgElement; title: string; blurb: string }[] = [
  {
    icon: UserGroupIcon as IconSvgElement,
    title: "Streaming payroll",
    blurb:
      "Pay salaries and contractors by the second. Fund once; their balance grows live. Start, pause, or stop anytime, gas is free, so per-second pay is economical.",
  },
  {
    icon: SentIcon as IconSvgElement,
    title: "Batch payouts",
    blurb:
      "Pay one person or ten thousand in a single action. Recipients claim with a Google sign-in, no prior account, no app, no wallet to set up.",
  },
  {
    icon: Invoice01Icon as IconSvgElement,
    title: "Invoices & payment links",
    blurb:
      "Send a link, get paid in digital dollars. Settles on Sui in about a second, with an on-chain receipt, verified, not asserted.",
  },
  {
    icon: Briefcase01Icon as IconSvgElement,
    title: "Work contracts",
    blurb:
      "Milestone-based, escrowed payouts settled on-chain. Funds release as the work lands, clean for freelance and cross-border teams.",
  },
];

function FeatureGrid() {
  return (
    <section className="pt-24 md:pt-32">
      <div className="max-w-[640px]">
        <span className="bp-kicker">talise for business</span>
        <h2 className="mt-3 text-[clamp(28px,3.6vw,42px)] leading-[1.08]">
          The same gasless rails, now for teams.
        </h2>
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:gap-5">
        {FEATURES.map((f) => (
          <div
            key={f.title}
            className="bp-card p-6 transition-colors hover:border-[color-mix(in_srgb,var(--color-accent-deep)_40%,var(--color-line))]"
          >
            <span
              className="flex size-11 items-center justify-center rounded-[8px] text-[var(--color-accent-deep)]"
              style={{ background: "var(--color-accent-soft)" }}
            >
              <HugeiconsIcon icon={f.icon} size={22} strokeWidth={1.8} />
            </span>
            <h3 className="mt-4 text-[18px] tracking-[-0.02em] text-[var(--color-fg)]">
              {f.title}
            </h3>
            <p className="mt-1.5 font-mono text-[13px] leading-[1.6] text-[var(--color-fg-muted)]">
              {f.blurb}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── How it works ───────────────────────────────────────────────────────────────

const STEPS: { icon: IconSvgElement; title: string; blurb: string }[] = [
  {
    icon: GoogleIcon as IconSvgElement,
    title: "Sign in with Google",
    blurb: "No seed phrase, no wallet to install. Your team and clients are in with one tap.",
  },
  {
    icon: BankIcon as IconSvgElement,
    title: "Fund once",
    blurb: "Top up in digital dollars (USDsui). One balance powers payroll, payouts, and invoices.",
  },
  {
    icon: FlashIcon as IconSvgElement,
    title: "Pay & get paid",
    blurb: "Send to a name or a link. Settles on Sui in about a second, and you cover no gas.",
  },
];

function HowItWorks() {
  return (
    <section className="pt-24 md:pt-32">
      <div className="max-w-[640px]">
        <span className="bp-kicker">how it works</span>
        <h2 className="mt-3 text-[clamp(28px,3.6vw,42px)] leading-[1.08]">
          Onboard a business in minutes.
        </h2>
      </div>

      <div className="mt-10 grid gap-6 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <div key={s.title}>
            <div className="flex items-center gap-3">
              <span
                className="flex size-10 items-center justify-center rounded-[8px] text-[var(--color-accent-deep)]"
                style={{ background: "var(--color-accent-soft)" }}
              >
                <HugeiconsIcon icon={s.icon} size={20} strokeWidth={1.8} />
              </span>
              <span className="font-mono text-[12px] text-[var(--color-fg-dim)]">
                0{i + 1}
              </span>
            </div>
            <h3 className="mt-4 text-[17px] tracking-[-0.02em] text-[var(--color-fg)]">
              {s.title}
            </h3>
            <p className="mt-1.5 font-mono text-[13px] leading-[1.6] text-[var(--color-fg-muted)]">
              {s.blurb}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Final CTA ───────────────────────────────────────────────────────────────────

function FinalCta() {
  return (
    <section className="pt-24 md:pt-32">
      <div className="bp-card relative overflow-hidden px-8 py-14 text-center sm:px-12 sm:py-16">
        <h2 className="mx-auto max-w-[640px] text-[clamp(28px,4vw,44px)] leading-[1.08]">
          Bring your business onto Talise.
        </h2>
        <p className="mx-auto mt-4 max-w-[480px] font-mono text-[14px] leading-[1.6] text-[var(--color-fg-muted)]">
          Payroll, payouts, and invoices on one gasless account. Settled on Sui,
          in digital dollars.
        </p>
        <div className="mx-auto mt-8 flex w-full max-w-[320px] flex-col items-stretch gap-2.5 sm:max-w-none sm:flex-row sm:items-center sm:justify-center">
          <Link
            href="/business/dashboard"
            className="inline-flex h-12 w-full items-center justify-center rounded-[8px] bg-[var(--color-accent-deep)] px-7 font-mono text-[13px] uppercase tracking-[0.06em] text-white transition-colors hover:bg-[#256016] sm:w-auto"
          >
            Open dashboard
          </Link>
          <Link
            href="https://www.talise.io/waitlist"
            className="inline-flex h-12 w-full items-center justify-center rounded-[8px] border border-[var(--color-line)] bg-[var(--color-surface)] px-7 font-mono text-[13px] uppercase tracking-[0.06em] text-[var(--color-fg)] transition-colors hover:border-[var(--color-accent-deep)] hover:text-[var(--color-accent-deep)] sm:w-auto"
          >
            Join the waitlist
          </Link>
        </div>
      </div>
    </section>
  );
}

// ── Footer ───────────────────────────────────────────────────────────────────

function SiteFooter() {
  return (
    <footer className="border-t border-[var(--color-line)] px-6 py-8 md:px-10">
      <div className="flex flex-col items-start gap-3 pt-6 font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)] sm:flex-row sm:items-center sm:justify-between">
        <span>© {new Date().getFullYear()} Talise, Inc. · Built on Sui</span>
        <FooterLinks />
      </div>
    </footer>
  );
}

function FooterLinks(): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <Link href="/" className="hover:text-[var(--color-fg)]">
        Personal
      </Link>
      <Link href="/litepaper" className="hover:text-[var(--color-fg)]">
        Litepaper
      </Link>
      <a
        href="https://x.com/taliseio"
        target="_blank"
        rel="noreferrer noopener"
        className="hover:text-[var(--color-fg)]"
      >
        X / Twitter
      </a>
    </div>
  );
}
