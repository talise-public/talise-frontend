import Link from "next/link";
import type { Metadata } from "next";
import { WaitlistForm } from "./WaitlistForm";
import { HowItWorks, MoreWays, Earn, Trust } from "../v2/MoreSections";

export const metadata: Metadata = {
  title: "Talise. Join the waitlist.",
  description:
    "Join the Talise waitlist, a dollar wallet you fund and send by @handle, gasless, no seed phrase.",
};

/**
 * Waitlist OPEN, collecting sign-ups. Joining records a sign-up only (no gas);
 * handle minting / sponsored txns happen later at activation. Flip to true to
 * show the "waitlist is full" state and pause new sign-ups.
 */
const WAITLIST_FULL = false;

const DISPLAY = { fontFamily: "var(--font-display-v2)" } as const;

function Wordmark() {
  return (
    <svg width="26" height="26" viewBox="0 0 583 533" aria-hidden>
      <path d="M375.231 85.2803C375.232 120.604 403.867 149.24 439.191 149.24H582.036V195.141C582.036 275.133 517.696 340.098 437.943 341.108L435.271 341.125C402.04 341.546 375.232 368.614 375.231 401.944V533H345.384C260.606 533 191.88 464.274 191.88 379.496V341.12H0V303.18C8.18875e-05 219.067 67.6907 150.62 151.798 149.686L191.875 149.24V341.119H427.871C396.135 332.728 367.039 316.441 343.293 293.774L191.876 149.24H191.88V63.96C191.88 28.6358 220.516 0 255.84 0H375.231V85.2803Z" fill="#15300c" />
    </svg>
  );
}

/**
 * Talise waitlist, restyled in the v2 brand language (Hanken display, mint
 * gradient, bento, hard offset shadow). The hero handles both the "full" and
 * "open" states; below it the same explainer sections from the landing go
 * deeper on the product. Fully responsive.
 */
export default function WaitlistPage() {
  return (
    <main className="relative">
      {/* top bar */}
      <div className="mx-auto flex max-w-[1500px] items-center justify-between px-6 pt-7 md:px-12">
        <Link href="/" className="flex items-center gap-2.5">
          <Wordmark />
          <span className="text-[19px] font-[600] tracking-[-0.01em]" style={DISPLAY}>talise</span>
        </Link>
        <Link href="/" className="rounded-full border border-[#15300c]/20 px-5 py-2 text-[13px] font-semibold text-[#15300c] transition-colors hover:bg-[#15300c] hover:text-[#f7fcf2]">
          Back to home
        </Link>
      </div>

      {/* hero */}
      <section className="mx-auto max-w-[760px] px-6 pt-20 pb-16 text-center md:pt-28">
        {WAITLIST_FULL ? (
          <>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#15300c]/15 bg-white/60 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.22em] text-[#3d7a29] backdrop-blur-sm">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#3d7a29]" /> Waitlist · closed
            </div>
            <h1 className="text-[clamp(30px,7.8vw,86px)] font-[800] uppercase leading-[0.94] tracking-[-0.02em] text-[#15300c]" style={DISPLAY}>
              The waitlist{" "}
              <span className="relative inline-block">
                <span className="absolute inset-x-[-8px] inset-y-[6px] -z-0 -rotate-[1.5deg] rounded-[12px] bg-[#CAFFB8]" />
                <span className="relative z-10">is full.</span>
              </span>
            </h1>
            <p className="mx-auto mt-6 max-w-[460px] text-[17px] leading-[1.55] text-[#3a5230]">
              We have reached capacity for this round and paused new sign-ups. Follow{" "}
              <a href="https://x.com/taliseio" target="_blank" rel="noreferrer noopener" className="font-semibold text-[#3d7a29] underline-offset-2 hover:underline">@taliseio</a>
              , we will open the next round soon.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <a href="https://x.com/taliseio" target="_blank" rel="noreferrer noopener" className="inline-flex h-[52px] items-center gap-2 rounded-full bg-[#15300c] px-7 text-[15px] font-semibold text-[#f7fcf2] transition-transform hover:-translate-y-0.5">
                Follow @taliseio <span aria-hidden>↗</span>
              </a>
              <Link href="/" className="inline-flex h-[52px] items-center rounded-full border-2 border-[#15300c] px-7 text-[15px] font-semibold text-[#15300c] transition-colors hover:bg-[#15300c] hover:text-[#f7fcf2]">
                Back to home
              </Link>
            </div>
          </>
        ) : (
          <>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#15300c]/15 bg-white/60 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.22em] text-[#3d7a29] backdrop-blur-sm">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#3d7a29]" /> Waitlist · open
            </div>
            <h1 className="text-[clamp(30px,7.8vw,86px)] font-[800] uppercase leading-[0.94] tracking-[-0.02em] text-[#15300c]" style={DISPLAY}>
              Get an{" "}
              <span className="relative inline-block">
                <span className="absolute inset-x-[-8px] inset-y-[6px] -z-0 -rotate-[1.5deg] rounded-[12px] bg-[#CAFFB8]" />
                <span className="relative z-10">@handle</span>
              </span>{" "}
              that holds dollars.
            </h1>
            <p className="mx-auto mt-6 max-w-[460px] text-[17px] leading-[1.55] text-[#3a5230]">
              Hold dollars, send home in under a second, earn on idle balance.
            </p>
            <div className="mx-auto mt-8 w-full max-w-[460px]">
              <WaitlistForm />
            </div>
          </>
        )}
      </section>

      {/* explainer sections, same designs as the landing */}
      <div id="start" className="scroll-mt-8"><HowItWorks /></div>
      <MoreWays />
      <Earn />
      <Trust />

      {/* footer */}
      <footer className="mx-auto w-full max-w-[1400px] px-6 pb-12 pt-8 md:px-12">
        <div className="flex flex-col items-start gap-3 border-t border-[#15300c]/10 pt-6 font-mono text-[12px] text-[#3a5230] sm:flex-row sm:items-center sm:justify-between">
          <span>© 2026 Talise, Inc. · Built on Sui.</span>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Link href="/litepaper" className="hover:text-[#15300c]">Litepaper</Link>
            <a href="https://x.com/taliseio" target="_blank" rel="noreferrer noopener" className="hover:text-[#15300c]">X / Twitter</a>
            <a href="https://sui.io" target="_blank" rel="noreferrer noopener" className="hover:text-[#15300c]">Sui</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
