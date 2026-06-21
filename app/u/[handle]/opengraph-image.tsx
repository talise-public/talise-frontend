import { ImageResponse } from "next/og";
import { userByHandle } from "@/lib/db";

// nodejs (not edge): userByHandle pulls in `postgres`, which needs node net/tls.
export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Talise profile card";

// Brand diamond (mint), embedded as a data-URI <img> — satori renders data
// URIs reliably across versions.
const DIAMOND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="51" viewBox="0 0 583 533"><path d="M375.231 85.2803C375.232 120.604 403.867 149.24 439.191 149.24H582.036V195.141C582.036 275.133 517.696 340.098 437.943 341.108L435.271 341.125C402.04 341.546 375.232 368.614 375.231 401.944V533H345.384C260.606 533 191.88 464.274 191.88 379.496V341.12H0V303.18C8.18875e-05 219.067 67.6907 150.62 151.798 149.686L191.875 149.24V341.119H427.871C396.135 332.728 367.039 316.441 343.293 293.774L191.876 149.24H191.88V63.96C191.88 28.6358 220.516 0 255.84 0H375.231V85.2803Z" fill="#caffb8"/></svg>`;
const DIAMOND_SRC = `data:image/svg+xml;base64,${Buffer.from(DIAMOND_SVG).toString("base64")}`;

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const h = decodeURIComponent(handle).replace(/^@+/, "").trim().toLowerCase();
  let found = false;
  let display = h;
  let referralCount = 0;
  try {
    const user = await userByHandle(h);
    if (user?.talise_username) {
      display = user.talise_username;
      found = true;
    }
    referralCount = Number(user?.referral_count ?? 0) || 0;
  } catch {
    /* unresolved → render the generic invite card below */
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "1200px",
          height: "630px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px",
          background:
            "radial-gradient(120% 100% at 85% -10%, #4b8a37 0%, #1c3d24 36%, #0a140c 72%, #060a07 100%)",
          color: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        {/* top row — brand + waitlist tag */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={DIAMOND_SRC} width={56} height={51} alt="" />
            <span
              style={{ fontSize: "32px", fontWeight: 600, marginLeft: "18px" }}
            >
              Talise
            </span>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: "20px",
              letterSpacing: "5px",
              color: "#caffb8",
              border: "1px solid rgba(202,255,184,0.35)",
              borderRadius: "999px",
              padding: "10px 22px",
            }}
          >
            WAITLIST
          </div>
        </div>

        {/* the name (or a generic invite when the handle doesn't resolve) */}
        {found ? (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: "112px", fontWeight: 700, lineHeight: 1 }}>
              @{display}
            </span>
            <span
              style={{ fontSize: "32px", color: "#caffb8", marginTop: "20px" }}
            >
              {display}.talise.sui
            </span>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span
              style={{ fontSize: "88px", fontWeight: 700, lineHeight: 1.05 }}
            >
              Claim your name.
            </span>
            <span
              style={{ fontSize: "32px", color: "#caffb8", marginTop: "20px" }}
            >
              An @handle that holds dollars.
            </span>
          </div>
        )}

        {/* bottom row */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span
              style={{
                fontSize: "20px",
                letterSpacing: "5px",
                color: "rgba(255,255,255,0.5)",
              }}
            >
              ON THE TALISE WAITLIST
            </span>
            <span
              style={{ fontSize: "28px", color: "#ffffff", marginTop: "12px" }}
            >
              Claim your name → talise.io
            </span>
          </div>
          {referralCount > 0 ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
              }}
            >
              <span
                style={{
                  fontSize: "20px",
                  letterSpacing: "5px",
                  color: "rgba(255,255,255,0.5)",
                }}
              >
                REFERRALS
              </span>
              <span
                style={{
                  fontSize: "48px",
                  fontWeight: 700,
                  color: "#caffb8",
                  marginTop: "6px",
                }}
              >
                {referralCount}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    ),
    { ...size }
  );
}
