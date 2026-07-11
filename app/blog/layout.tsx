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
    <div
      className={`${display.variable} ${sans.variable} relative min-h-screen overflow-x-hidden`}
      style={{
        fontFamily: "var(--font-sans-v2), system-ui, sans-serif",
        color: "#15300c",
        background:
          "radial-gradient(120% 90% at 12% -5%, #e6f9d6 0%, #f7fcf2 46%, #ffeede 100%)",
      }}
    >
      {/* top brand mark */}
      <header className="mx-auto flex max-w-[1500px] items-center justify-between px-6 pt-7 md:px-12">
        <Link href="/" className="flex items-center gap-2.5">
          <svg width="24" height="24" viewBox="0 0 583 533" aria-hidden>
            <path
              d="M375.231 85.2803C375.232 120.604 403.867 149.24 439.191 149.24H582.036V195.141C582.036 275.133 517.696 340.098 437.943 341.108L435.271 341.125C402.04 341.546 375.232 368.614 375.231 401.944V533H345.384C260.606 533 191.88 464.274 191.88 379.496V341.12H0V303.18C8.18875e-05 219.067 67.6907 150.62 151.798 149.686L191.875 149.24V341.119H427.871C396.135 332.728 367.039 316.441 343.293 293.774L191.876 149.24H191.88V63.96C191.88 28.6358 220.516 0 255.84 0H375.231V85.2803Z"
              fill="#15300c"
            />
          </svg>
          <span
            className="text-[18px] font-[600] tracking-[-0.01em]"
            style={{ fontFamily: "var(--font-display-v2)" }}
          >
            talise
          </span>
        </Link>
        <Link
          href="/blog"
          className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#3d7a29] transition-colors hover:text-[#15300c]"
        >
          Blog
        </Link>
      </header>

      {children}

      {/* footer */}
      <footer className="mx-auto flex max-w-[1500px] flex-col items-center gap-4 px-6 pb-24 pt-10 text-center md:px-12">
        <a
          href="https://x.com/taliseio"
          target="_blank"
          rel="noreferrer noopener"
          aria-label="Talise on X"
          className="grid h-10 w-10 place-items-center rounded-full border border-[#15300c]/20 text-[#15300c] transition-colors hover:bg-[#15300c] hover:text-[#f7fcf2]"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        </a>
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#3d7a29]">
          talise.io · Built on Sui
        </div>
      </footer>
    </div>
  );
}
