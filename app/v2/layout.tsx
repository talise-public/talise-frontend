import type { ReactNode } from "react";
import { Hanken_Grotesk, DM_Sans } from "next/font/google";

// Clean, heavy grotesque that reads great in ALL-CAPS display (the bold,
// confident Wero-style headline treatment).
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

export default function V2Layout({ children }: { children: ReactNode }) {
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
      {children}
    </div>
  );
}
