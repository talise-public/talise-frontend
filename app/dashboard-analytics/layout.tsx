import { Hanken_Grotesk, DM_Sans } from "next/font/google";

// Mirror the v2 type system used across /app so the dashboard reads as one product.
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

export default function DashboardAnalyticsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className={`app-clean ${display.variable} ${sans.variable} relative min-h-screen overflow-x-hidden`}
      style={{ fontFamily: "var(--font-sans-v2), system-ui, sans-serif" }}
    >
      {children}
    </div>
  );
}
