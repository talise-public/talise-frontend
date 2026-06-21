import { Hanken_Grotesk, DM_Sans } from "next/font/google";
import LandingV2 from "./v2/page";

// Same type system as the /v2 preview (app/v2/layout.tsx) so the production
// landing renders identically — Hanken display + DM Sans body, scoped here as
// CSS variables on the wrapper below.
const display = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["700", "800"],
  variable: "--font-display-v2",
  display: "swap",
});
const sans = DM_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-sans-v2",
  display: "swap",
});

export const dynamic = "force-dynamic";

/**
 * Production landing = the v2 design (Wero-inspired, mint brand). The full
 * composition lives in app/v2/page.tsx (LandingV2); here we just provide the
 * v2 font variables + mint-gradient background wrapper (the same wrapper the
 * /v2 preview route gets from app/v2/layout.tsx) so `/` renders identically.
 */
export default function Landing() {
  return (
    <div
      className={`${display.variable} ${sans.variable} relative min-h-screen overflow-x-hidden`}
      style={{
        fontFamily: "var(--font-sans-v2), system-ui, sans-serif",
        color: "#15300c",
        background: "radial-gradient(120% 90% at 12% -5%, #e6f9d6 0%, #f7fcf2 46%, #ffeede 100%)",
      }}
    >
      <LandingV2 />
    </div>
  );
}
