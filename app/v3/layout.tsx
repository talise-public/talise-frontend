import type { ReactNode } from "react";
import { Hanken_Grotesk, DM_Sans } from "next/font/google";
import "./v3.css";

// Display fallback, Hanken Grotesk stands in for TWK Everett (a licensed
// Weltkern font we can't redistribute). Exposed as --font-hanken-v3; v3.css
// composes the real display stack as `"TWK Everett", var(--font-hanken-v3), …`
// so dropping the licensed woff2s into /public/fonts activates Everett with no
// code change, and until then this close grotesque carries the headings.
const display = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-hanken-v3",
  display: "swap",
});

// Body, DM Sans: quiet, legible running copy.
const body = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body-v3",
  display: "swap",
});

// JetBrains Mono (labels, badges, section counters, button text) comes from
// the root layout as --font-mono and is central to this aesthetic.

export default function V3Layout({ children }: { children: ReactNode }) {
  return (
    <div
      className={`landing-v3 ${display.variable} ${body.variable} relative min-h-screen overflow-x-hidden`}
    >
      {children}
    </div>
  );
}
