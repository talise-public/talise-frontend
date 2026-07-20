import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

/**
 * Branded "you got paid" card for the iOS Notification Service Extension.
 *
 * The system notification banner chrome (the card, fonts, background) is
 * owned by iOS and CANNOT be themed by an app. The one way to put Talise's
 * look INTO a notification is a rich-media attachment: the NSE downloads
 * this PNG and attaches it, so the EXPANDED / long-pressed notification
 * shows a mint Talise card with the amount, our theme, not the OS's.
 *
 * Stateless + public by design: it renders ONLY what's already in the
 * notification text (amount, currency, sender handle), so there's nothing
 * here that isn't on the banner already, no balance, no PII beyond the
 * sender label the recipient can already see.
 *
 *   /api/notify/card?amount=%E2%82%A68%2C100&from=caleb@talise
 *
 * `amount` is the already-localized display string ("₦8,100"), so the card
 * matches the banner copy exactly and we never re-do FX here.
 */
export const runtime = "nodejs";
// Notification attachments display at the device width; a wide card reads
// cleanly both as the collapsed thumbnail and the expanded image.
const size = { width: 1056, height: 576 };

// Mint diamond, embedded as a data-URI <img>, satori renders data URIs
// reliably across versions (matches app/u/[handle]/opengraph-image.tsx).
const DIAMOND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="58" viewBox="0 0 583 533"><path d="M375.231 85.2803C375.232 120.604 403.867 149.24 439.191 149.24H582.036V195.141C582.036 275.133 517.696 340.098 437.943 341.108L435.271 341.125C402.04 341.546 375.232 368.614 375.231 401.944V533H345.384C260.606 533 191.88 464.274 191.88 379.496V341.12H0V303.18C8.18875e-05 219.067 67.6907 150.62 151.798 149.686L191.875 149.24V341.119H427.871C396.135 332.728 367.039 316.441 343.293 293.774L191.876 149.24H191.88V63.96C191.88 28.6358 220.516 0 255.84 0H375.231V85.2803Z" fill="#B1F49A"/></svg>`;
const DIAMOND_SRC = `data:image/svg+xml;base64,${Buffer.from(DIAMOND_SVG).toString("base64")}`;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  // Pre-localized amount string from the push composer ("₦8,100"). Clamp
  // length so a malformed query can never blow out the layout.
  const amount = (sp.get("amount") ?? "").slice(0, 24) || "Payment received";
  const fromRaw = (sp.get("from") ?? "").slice(0, 40).trim();
  const from = fromRaw ? `from ${fromRaw}` : "Money received";

  return new ImageResponse(
    (
      <div
        style={{
          width: `${size.width}px`,
          height: `${size.height}px`,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          // Talise success-screen theme: near-black field with a soft mint
          // glow at the top, the same world as SuccessfulTxView.
          background:
            "radial-gradient(115% 95% at 80% -15%, #20371d 0%, #0e1a0d 45%, #070d07 100%)",
          color: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        {/* brand row */}
        <div style={{ display: "flex", alignItems: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={DIAMOND_SRC} width={64} height={58} alt="" />
          <span
            style={{ fontSize: "36px", fontWeight: 600, marginLeft: "20px" }}
          >
            Talise
          </span>
        </div>

        {/* the money, the hero */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span
            style={{
              fontSize: "132px",
              fontWeight: 700,
              lineHeight: 1,
              letterSpacing: "-3px",
              color: "#B1F49A",
            }}
          >
            {amount}
          </span>
          <span
            style={{
              fontSize: "40px",
              color: "rgba(255,255,255,0.92)",
              marginTop: "22px",
            }}
          >
            {from}
          </span>
        </div>

        {/* footer reassurance, factual, no claims */}
        <div style={{ display: "flex", alignItems: "center" }}>
          <span
            style={{
              fontSize: "22px",
              letterSpacing: "4px",
              color: "rgba(177,244,154,0.85)",
            }}
          >
            RECEIVED ON TALISE
          </span>
        </div>
      </div>
    ),
    { ...size }
  );
}
