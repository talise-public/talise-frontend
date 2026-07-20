import { Hanken_Grotesk, DM_Sans } from "next/font/google";
import "./v3/v3.css";
import LandingV3 from "./v3/page";

// Display fallback, Hanken Grotesk stands in for TWK Everett (a licensed
// Weltkern font). v3.css composes the real display stack as
// `"TWK Everett", var(--font-hanken-v3), …`, so dropping the licensed woff2s
// into /public/fonts activates Everett with no code change.
const display = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-hanken-v3",
  display: "swap",
});
const body = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body-v3",
  display: "swap",
});

export const dynamic = "force-dynamic";

/**
 * Production landing = the v3 engineering-blueprint design (Finexis-inspired
 * construction grid + corner ticks + mono microtype + bracket buttons, in
 * Talise's own brand: neutral canvas, forest-green accent, real app screens).
 * The composition lives in app/v3/page.tsx (LandingV3); here we reproduce the
 * v3 layout wrapper (scope class + fonts + v3.css) so `/` renders identically
 * to the /v3 preview. The prior v2 (mint) landing is archived at /v2.
 */
export default function Landing() {
  return (
    <div
      className={`landing-v3 ${display.variable} ${body.variable} relative min-h-screen overflow-x-hidden`}
    >
      <LandingV3 />
    </div>
  );
}
