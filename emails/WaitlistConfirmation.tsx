/**
 * Talise waitlist confirmation email.
 *
 * Rendered to HTML via @react-email/render before being handed to the
 * Resend client.
 *
 * Design goals:
 *   - Light theme that renders predictably across Gmail, Apple Mail,
 *     and Outlook. We explicitly opt out of Gmail's dark-mode
 *     auto-inversion via the color-scheme meta tags below, because
 *     auto-inverted light emails look broken.
 *   - Structure inspired by Luma/Stripe transactional emails: header
 *     wordmark, large greeting, body block, single CTA, subtle footer.
 *   - One CTA only: the litepaper link. Black pill on white for the
 *     "premium" Stripe/Linear feel.
 *
 * Copy rules (load-bearing):
 *   1. No em dashes anywhere.
 *   2. Tight. Quick to read.
 *   3. Plain English, no marketing fluff.
 */
import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";

export type WaitlistConfirmationProps = {
  /** Optional first name captured from the form. */
  name?: string | null;
  /** Public base URL for absolute links (litepaper, signup URL). */
  appUrl: string;
  /**
   * Bare claimed handle (no `@`, no `.talise.sui`). When set, the email
   * surfaces it as a confirmation pill and explains the iOS sign-in
   * binding behavior. When null, the email is the original
   * email-only confirmation.
   */
  claimedHandle?: string | null;
};

const COLORS = {
  // Outer body MUST be pure white. Gmail's dark-mode renderer uses
  // #FFFFFF as the "this is a light email, do not invert" signal.
  // Anything else triggers inversion and makes text invisible.
  bodyBg: "#FFFFFF",
  // The visible "page" area inside the body. Light grey gives the
  // iOS-card lift effect; Gmail doesn't inspect inner backgrounds.
  bg: "#F4F5F7",
  // The "What Talise does" card sits inside the grey page as white.
  surface: "#FFFFFF",
  fg: "#0A0A0A",
  fgMuted: "#52525B",
  fgDim: "#A1A1AA",
  accent: "#0A0A0A",
  accentText: "#FFFFFF",
  line: "#E4E4E7",
};

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

export function WaitlistConfirmation({
  name,
  appUrl,
  claimedHandle,
}: WaitlistConfirmationProps) {
  const litepaperUrl = `${appUrl.replace(/\/$/, "")}/litepaper`;
  const greeting = name && name.trim().length > 0 ? `, ${name.trim()}` : "";
  const handle = claimedHandle?.trim() || null;

  return (
    <Html lang="en">
      <Head>
        {/*
          Minimal head. We intentionally do NOT set color-scheme meta
          tags or a <style> block: those interact badly with Gmail's
          dark-mode renderer, which forces text white over our
          background and produces an empty-looking email. Pure inline
          styles + explicit text colors render predictably across
          Gmail (light + dark mode), Apple Mail, and Outlook.
        */}
      </Head>
      <Preview>You are on the Talise waitlist.</Preview>
      <Body
        // Pure white body so Gmail trusts the rendering. The grey
        // "page" lives one level inside.
        style={{
          margin: 0,
          padding: 0,
          backgroundColor: COLORS.bodyBg,
          color: COLORS.fg,
          fontFamily: FONT_STACK,
          WebkitFontSmoothing: "antialiased",
        }}
      >
        {/* Grey page wrapper. This is the visible area; the white
            <Body> behind it is invisible padding that signals "light
            email" to Gmail. */}
        <Section
          style={{ backgroundColor: COLORS.bg, padding: "56px 0 80px 0" }}
        >
          <Container
            style={{
              maxWidth: "600px",
              width: "100%",
              margin: "0 auto",
              backgroundColor: COLORS.bg,
            }}
          >
            {/* Header: real Talise glyph (PNG, 1x + 2x) + wordmark.
                PNG hosted on the public Next.js public/ folder so it
                renders in Gmail / Outlook / Apple Mail without needing
                inline SVG support. The glyph is the actual brand
                symbol from /public/symbol.svg, rasterized via resvg. */}
            <Section
              style={{
                padding: "0 40px 40px 40px",
                backgroundColor: COLORS.bg,
              }}
            >
              <table
                role="presentation"
                cellPadding={0}
                cellSpacing={0}
                border={0}
                style={{ borderCollapse: "collapse" }}
              >
                <tbody>
                  <tr>
                    <td style={{ verticalAlign: "middle", paddingRight: "12px" }}>
                      <Img
                        src={`${appUrl.replace(/\/$/, "")}/symbol.png`}
                        srcSet={`${appUrl.replace(/\/$/, "")}/symbol.png 1x, ${appUrl.replace(/\/$/, "")}/symbol@2x.png 2x`}
                        alt=""
                        width={24}
                        height={22}
                        style={{
                          display: "block",
                          border: 0,
                          outline: "none",
                          textDecoration: "none",
                        }}
                      />
                    </td>
                    <td style={{ verticalAlign: "middle" }}>
                      <Text
                        className="talise-wordmark"
                        style={{
                          margin: 0,
                          fontSize: "18px",
                          fontWeight: 500,
                          color: COLORS.fg,
                          lineHeight: 1,
                          letterSpacing: "-0.01em",
                        }}
                      >
                        talise
                      </Text>
                    </td>
                  </tr>
                </tbody>
              </table>
            </Section>

            {/* Heading. */}
            <Section
              style={{
                padding: "0 40px 0 40px",
                backgroundColor: COLORS.bg,
              }}
            >
              <Heading
                as="h1"
                style={{
                  margin: 0,
                  fontSize: "38px",
                  lineHeight: 1.1,
                  letterSpacing: "-0.025em",
                  fontWeight: 500,
                  color: COLORS.fg,
                }}
              >
                You are on the list{greeting}.
              </Heading>
            </Section>

            {/* Body paragraphs. */}
            <Section
              style={{
                padding: "32px 40px 0 40px",
                backgroundColor: COLORS.bg,
              }}
            >
              <Text
                style={{
                  margin: "0 0 22px 0",
                  fontSize: "16px",
                  lineHeight: 1.65,
                  color: COLORS.fgMuted,
                }}
              >
                {handle
                  ? "Your handle is reserved and live on chain. Talise opens to private beta in small batches over the next few weeks, starting with the African remittance corridor."
                  : "Thanks for joining the Talise waitlist. We are letting people in privately, in small batches, while we get the product ready for the African remittance corridor."}
              </Text>
              <Text
                style={{
                  margin: "0",
                  fontSize: "16px",
                  lineHeight: 1.65,
                  color: COLORS.fgMuted,
                }}
              >
                {handle
                  ? "We will email you once when the app is ready for you. Nothing in between."
                  : "When it is your turn we will send one short email with a sign-in link. You will not hear from us between now and then."}
              </Text>
            </Section>

            {/* Claimed-handle pill — only rendered when the user
                claimed a handle along with their email. Explains the
                iOS sign-in binding so the user knows what to expect. */}
            {handle ? (
              <Section
                style={{
                  padding: "28px 40px 0 40px",
                  backgroundColor: COLORS.bg,
                }}
              >
                <table
                  role="presentation"
                  cellPadding={0}
                  cellSpacing={0}
                  border={0}
                  style={{ borderCollapse: "collapse" }}
                >
                  <tbody>
                    <tr>
                      <td
                        style={{
                          backgroundColor: COLORS.surface,
                          border: `1px solid ${COLORS.line}`,
                          borderRadius: "12px",
                          padding: "16px 20px",
                        }}
                      >
                        <Text
                          style={{
                            margin: "0 0 6px 0",
                            fontSize: "12px",
                            lineHeight: 1.4,
                            color: COLORS.fgDim,
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                          }}
                        >
                          Your handle, on chain
                        </Text>
                        <Text
                          style={{
                            margin: "0 0 10px 0",
                            fontSize: "18px",
                            lineHeight: 1.3,
                            color: COLORS.fg,
                            fontWeight: 600,
                          }}
                        >
                          {handle}@talise.sui
                        </Text>
                        <Text
                          style={{
                            margin: 0,
                            fontSize: "14px",
                            lineHeight: 1.5,
                            color: COLORS.fgMuted,
                          }}
                        >
                          Minted to your Sui wallet. Anyone can send to
                          it right now. Open Talise on iOS with this
                          email to use it.
                        </Text>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </Section>
            ) : null}

            {/* CTA: black pill, Stripe/Linear style on light. */}
            <Section
              style={{
                padding: "48px 40px 0 40px",
                backgroundColor: COLORS.bg,
              }}
            >
              <Link
                href={litepaperUrl}
                style={{
                  display: "inline-block",
                  color: COLORS.accentText,
                  textDecoration: "none",
                  fontSize: "14px",
                  fontWeight: 600,
                  padding: "14px 26px",
                  borderRadius: "999px",
                  backgroundColor: COLORS.accent,
                }}
              >
                Read the litepaper
              </Link>
            </Section>

            <Hr
              style={{
                borderColor: COLORS.line,
                borderTop: `1px solid ${COLORS.line}`,
                borderBottom: "none",
                margin: "64px 40px 24px 40px",
              }}
            />

            {/* Footer. */}
            <Section
              style={{
                padding: "0 40px 0 40px",
                backgroundColor: COLORS.bg,
              }}
            >
              <Text
                style={{
                  margin: "0 0 10px 0",
                  fontSize: "12px",
                  lineHeight: 1.65,
                  color: COLORS.fgDim,
                }}
              >
                Talise, Inc. Built on Sui. © 2026.
              </Text>
              <Text
                style={{
                  margin: "0 0 10px 0",
                  fontSize: "12px",
                  lineHeight: 1.65,
                  color: COLORS.fgDim,
                }}
              >
                You are receiving this because you signed up at{" "}
                <Link
                  href="https://talise.io/waitlist"
                  style={{
                    color: COLORS.fgMuted,
                    textDecoration: "underline",
                  }}
                >
                  talise.io/waitlist
                </Link>
                .
              </Text>
              <Text
                style={{
                  margin: 0,
                  fontSize: "12px",
                  lineHeight: 1.65,
                  color: COLORS.fgDim,
                }}
              >
                Reply to this email to remove yourself from the list.
              </Text>
            </Section>
          </Container>
        </Section>
      </Body>
    </Html>
  );
}

export default WaitlistConfirmation;
