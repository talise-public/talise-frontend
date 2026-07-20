import type { Metadata } from "next";
import Link from "next/link";
import { Diamond } from "@/components/Diamond";

export const metadata: Metadata = {
  title: "Support, Talise",
  description:
    "Get help with Talise. Contact support, read answers to common questions, and find our Privacy Policy and Terms.",
};

/**
 * /support, the Talise support page.
 *
 * Purpose-built (not the shared LegalPage prose shell) so the primary
 * action, emailing a human, leads the page as a real contact card, with
 * a clean FAQ underneath. Rendered in the engineering-blueprint (.bp-page)
 * visual language so it sits alongside /privacy and /terms. This is the
 * app's Support URL in App Store Connect, so it must resolve and read as
 * a real help page.
 */

const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: "How do I get access?",
    a: (
      <>
        Talise is in private beta and invite-only for now. You can request
        access at{" "}
        <a href="https://talise.io" className="text-[var(--color-accent-deep)] underline underline-offset-4 hover:opacity-80">
          talise.io
        </a>
        . We open the beta in batches, so it may take a little while to reach
        you.
      </>
    ),
  },
  {
    q: "Is Talise safe? Is it non-custodial?",
    a: (
      <>
        Yes. Talise is self-custodial. You sign in with Google or Apple, and
        your wallet keys are derived on your own device using Sui zkLogin. We
        never hold, store, or see your private keys, and we cannot move your
        money for you. Because of that, keeping access to your sign-in account
        matters. See our{" "}
        <Link href="/privacy" className="text-[var(--color-accent-deep)] underline underline-offset-4 hover:opacity-80">
          Privacy Policy
        </Link>{" "}
        for exactly what we collect and what we never do.
      </>
    ),
  },
  {
    q: "What is a @handle?",
    a: (
      <>
        Your @handle is the username you choose when you set up Talise, like
        @ada. It lets people pay you by name instead of copying a long
        blockchain address. Your handle is public so friends can find and pay
        you.
      </>
    ),
  },
  {
    q: "How do I send money?",
    a: (
      <>
        Open Talise, tap send, enter a person&apos;s @handle and an amount, and
        confirm. The payment lands in under a second and you never pay a network
        fee, we sponsor it. You can also share a payment link or an invoice with
        anyone.
      </>
    ),
  },
  {
    q: "How do I cash out to my bank?",
    a: (
      <>
        Cash-out availability depends on your country and can change during the
        beta. When it is open to you, link a bank account in the app and request
        a payout, and a licensed payment partner sends the funds to your bank.
        During the beta, cash-out is limited to $200 per day per account, and
        verifying your identity raises that. If you don&apos;t see a cash-out
        option, it isn&apos;t open in your region yet.
      </>
    ),
  },
  {
    q: "How do I delete my account?",
    a: (
      <>
        You can delete your account any time in the app under{" "}
        <strong>Profile, then Delete account</strong>. This removes your personal
        data from our systems and signs you out. Your funds are self-custodial,
        so withdraw or transfer any balance first. Transactions already recorded
        on the Sui blockchain are public and permanent by nature, so they
        can&apos;t be removed by us or anyone else.
      </>
    ),
  },
  {
    q: "I sent money to the wrong person. Can you reverse it?",
    a: (
      <>
        Payments on Talise are final once they settle on-chain, so we cannot
        reverse them for you. Always double-check the @handle before you confirm.
        If you were misled or something looks wrong, email us and we&apos;ll help
        however we can.
      </>
    ),
  },
];

export default function Support() {
  return (
    <div className="bp-page relative min-h-screen overflow-hidden">
      <div className="bp-frame flex min-h-screen flex-col" style={{ maxWidth: 840 }}>
        <span aria-hidden className="bp-tick bp-tick-tl" />
        <span aria-hidden className="bp-tick bp-tick-tr" />
        <span aria-hidden className="bp-tick bp-tick-bl" />
        <span aria-hidden className="bp-tick bp-tick-br" />

        <header className="flex items-center justify-between border-b border-[var(--color-line)] px-6 py-5 sm:px-10">
          <Link
            href="/"
            className="flex items-center gap-2.5 text-[17px] tracking-[-0.02em] text-[var(--color-fg)]"
          >
            <Diamond />
            <span>talise</span>
          </Link>
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-accent)]">Support</span>
        </header>

        <main className="flex-1 px-6 pb-24 pt-12 sm:px-10">
          <span className="bp-kicker">support</span>
          <h1 className="mt-5 text-[clamp(32px,5vw,48px)] leading-[1.05]">
            How can we help?
          </h1>
          <p className="mt-4 max-w-[52ch] font-mono text-[13px] leading-[1.7] text-[var(--color-fg-muted)]">
            Talise is a self-custodial money app built on Sui. If something
            isn&apos;t working, you have a question, or you want to share feedback,
            the fastest way to reach a human is by email.
          </p>

          {/* Primary action, the contact card, leads the page. */}
          <section
            className="bp-card mt-8 p-6 sm:p-7"
            aria-labelledby="contact-heading"
          >
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2
                  id="contact-heading"
                  className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)]"
                >
                  Email us
                </h2>
                <a
                  href="mailto:support@talise.io"
                  className="mt-1.5 block text-[clamp(22px,4.4vw,30px)] tracking-[-0.02em] text-[var(--color-fg)] hover:text-[var(--color-accent-deep)]"
                >
                  support@talise.io
                </a>
                <p className="mt-2 font-mono text-[12px] text-[var(--color-fg-muted)]">
                  We usually reply within a day.
                </p>
              </div>
              <a
                href="mailto:support@talise.io"
                className="inline-flex shrink-0 items-center justify-center rounded-[8px] bg-[var(--color-accent-deep)] px-6 py-3 font-mono text-[12px] uppercase tracking-[0.06em] text-white transition-colors hover:bg-[#256016]"
              >
                Contact support
              </a>
            </div>
            <p className="mt-5 border-t border-[var(--color-line)] pt-4 font-mono text-[12px] leading-[1.6] text-[var(--color-fg-muted)]">
              If your message is about your account, please write from the email
              address you signed in with so we can find you faster.
            </p>
          </section>

          {/* FAQ */}
          <section className="mt-14" aria-labelledby="faq-heading">
            <h2
              id="faq-heading"
              className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-accent)]"
            >
              Common questions
            </h2>
            <dl className="mt-5 divide-y divide-[var(--color-line)]">
              {FAQ.map(({ q, a }) => (
                <div key={q} className="py-6 first:pt-0">
                  <dt className="text-[17px] font-medium tracking-[-0.01em] text-[var(--color-fg)]">
                    {q}
                  </dt>
                  <dd className="mt-2.5 font-mono text-[13px] leading-[1.65] text-[var(--color-fg-muted)]">
                    {a}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <p className="mt-12 font-mono text-[13px] leading-[1.6] text-[var(--color-fg-muted)]">
            For the full details, read our{" "}
            <Link href="/privacy" className="text-[var(--color-accent-deep)] underline underline-offset-4 hover:opacity-80">
              Privacy Policy
            </Link>{" "}
            and{" "}
            <Link href="/terms" className="text-[var(--color-accent-deep)] underline underline-offset-4 hover:opacity-80">
              Terms of Service
            </Link>
            .
          </p>
        </main>

        <footer className="px-6 pb-10 sm:px-10">
          <div className="flex flex-col items-start gap-3 border-t border-[var(--color-line)] pt-6 font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)] sm:flex-row sm:items-center sm:justify-between">
            <span>© {new Date().getFullYear()} Talise · Built on Sui</span>
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
              <a
                href="mailto:support@talise.io"
                className="hover:text-[var(--color-fg)]"
              >
                support@talise.io
              </a>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
