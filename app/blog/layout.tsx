import type { Metadata } from "next";
import Link from "next/link";
import { Hanken_Grotesk, DM_Sans } from "next/font/google";

// Same type system as the production landing (app/page.tsx → v2): Hanken display
// + DM Sans body, scoped here as CSS variables so /blog renders in the brand.
const display = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-display-v2",
  display: "swap",
});
const sans = DM_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-sans-v2",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Blog · Talise",
  description: "Notes from the team building money that moves like a message.",
};

/** Brand chrome for every /blog page: mint-gradient bg, top wordmark, footer. */
export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`bp-page ${display.variable} ${sans.variable} relative min-h-screen overflow-x-hidden`}>
      <div className="bp-frame relative flex min-h-screen flex-col" style={{ maxWidth: 1200 }}>
        <span aria-hidden className="bp-tick bp-tick-tl" />
        <span aria-hidden className="bp-tick bp-tick-tr" />
        <span aria-hidden className="bp-tick bp-tick-bl" />
        <span aria-hidden className="bp-tick bp-tick-br" />

        {/* top brand mark */}
        <header className="flex items-center justify-between border-b border-[var(--color-line)] px-6 py-5 md:px-10">
          <Link href="/" className="flex items-center gap-2.5">
            <svg width="22" height="22" viewBox="0 0 583 533" aria-hidden>
              <path
                d="M375.231 85.2803C375.232 120.604 403.867 149.24 439.191 149.24H582.036V195.141C582.036 275.133 517.696 340.098 437.943 341.108L435.271 341.125C402.04 341.546 375.232 368.614 375.231 401.944V533H345.384C260.606 533 191.88 464.274 191.88 379.496V341.12H0V303.18C8.18875e-05 219.067 67.6907 150.62 151.798 149.686L191.875 149.24V341.119H427.871C396.135 332.728 367.039 316.441 343.293 293.774L191.876 149.24H191.88V63.96C191.88 28.6358 220.516 0 255.84 0H375.231V85.2803Z"
                fill="#121a0f"
              />
            </svg>
            <span className="text-[17px] tracking-[-0.03em] text-[var(--color-fg)]">talise</span>
          </Link>
          <Link href="/blog" className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-accent)] transition-colors hover:text-[var(--color-fg)]">
            Blog
          </Link>
        </header>

        <div className="flex-1">{children}</div>

        {/* footer */}
        <footer className="flex flex-col items-center gap-4 border-t border-[var(--color-line)] px-6 pb-16 pt-8 text-center md:px-10">
          <a
            href="https://x.com/taliseio"
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Talise on X"
            className="grid h-10 w-10 place-items-center border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] transition-colors hover:bg-[var(--color-accent)] hover:text-[#f4fbef]"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
          <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-accent)]">
            talise.io · Built on Sui
          </div>
        </footer>
      </div>
    </div>
  );
}
