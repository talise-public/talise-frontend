import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { JetBrains_Mono, Instrument_Serif } from "next/font/google";
import { ReferralCapture } from "@/components/ReferralCapture";
// Google Sans Variable, self-hosted via @fontsource. Google's marketing
// font isn't on the public Google Fonts API, but Fontsource ships an
// OFL-1.1 build, same weights, same shapes, distributable.
import "@fontsource-variable/google-sans/index.css";
import "./globals.css";

// Mono for addresses, code, and stat values.
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

// Instrument Serif (italic), used sparingly for emphasis inside headlines.
// e.g. "Send money home. Almost <em>free</em>." The italic style is what
// gives Reflect-style hero copy its premium feel.
const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["italic", "normal"],
  variable: "--font-serif",
  display: "swap",
});

const OG_TITLE = "Talise, money that moves like a message";
const OG_DESC =
  "A gasless dollar wallet on Sui. Send digital dollars as easily as a text, no gas, no seed phrases, no bank. Sign in with Google.";
const OG_IMAGE = {
  url: "/og.png",
  width: 1200,
  height: 630,
  type: "image/png",
  alt: "Talise. Money that moves like a message. Hold, send, cash out.",
};

export const metadata: Metadata = {
  title: OG_TITLE,
  description: OG_DESC,
  // Default to the production origin so crawler-fetched og:image / og:url are
  // ABSOLUTE in prod even if NEXT_PUBLIC_BASE_URL isn't set (a localhost
  // fallback would make every social preview image 404 for crawlers).
  metadataBase: new URL(process.env.NEXT_PUBLIC_BASE_URL || "https://www.talise.io"),
  icons: { icon: "/icon.png" },
  openGraph: {
    title: OG_TITLE,
    description: OG_DESC,
    url: "/",
    type: "website",
    siteName: "Talise",
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: OG_TITLE,
    description: OG_DESC,
    images: [OG_IMAGE.url],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${mono.variable} ${serif.variable}`}
    >
      <body>
        {/* Captures ?ref=CODE from invite links into the talise_ref cookie,
            attributed to the inviter on the new user's first sign-in. */}
        <ReferralCapture />
        {children}
        {/* Vercel Web Analytics, privacy-friendly route/pageview metrics
            (no cookies, no PII). Surfaces at the project's /analytics tab. */}
        <Analytics />
      </body>
    </html>
  );
}
