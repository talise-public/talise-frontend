import type { ReactNode } from "react";
import { Hanken_Grotesk, DM_Sans } from "next/font/google";

// Same type system as the v2 landing so the waitlist feels like one product.
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

export default function WaitlistLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className={`bp-page ${display.variable} ${sans.variable} relative min-h-screen overflow-x-hidden`}
    >
      {children}
    </div>
  );
}
