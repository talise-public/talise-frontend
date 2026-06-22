import type { ReactNode } from "react";
import { Hanken_Grotesk, DM_Sans } from "next/font/google";
import { getPublicAnalytics, type PublicAnalytics } from "@/lib/analytics";

const display = Hanken_Grotesk({ subsets: ["latin"], weight: ["700", "800"], display: "swap" });
const sans = DM_Sans({ subsets: ["latin"], weight: ["300", "400", "500", "600"], display: "swap" });

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Talise — Live network analytics",
  description:
    "Real, on-mainnet usage of Talise: value moved, active accounts, live cross-border corridors, and the shielded privacy pool. Read live from Sui mainnet.",
};

const BG = "#0a0e0b";
const SURFACE = "#131815";
const LINE = "#ffffff14";
const FG = "#f2f4f2";
const MUTED = "#b9c0bb";
const DIM = "#6f7872";
const MINT = "#caffb8";

function usd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
function num(n: number): string {
  return n.toLocaleString("en-US");
}

const FLAG: Record<string, string> = {
  USD: "🇺🇸",
  JPY: "🇯🇵",
  NGN: "🇳🇬",
  EUR: "🇪🇺",
  GBP: "🇬🇧",
  USDSUI: "🟢",
};
const DIRECTION_LABEL: Record<string, string> = {
  sent: "Dollar sends",
  received: "Received",
  swap: "Swaps to USDsui",
  withdraw: "Cash-outs",
  invest: "Yield deposits",
};

function Stat({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div style={{ background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 18, padding: "26px 24px" }}>
      <div style={{ fontFamily: display.style.fontFamily, fontWeight: 800, fontSize: "clamp(30px,5vw,44px)", color: MINT, letterSpacing: "-0.02em", lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ marginTop: 12, fontSize: 15, fontWeight: 600, color: FG }}>{label}</div>
      {sub ? <div style={{ marginTop: 4, fontSize: 13, color: DIM }}>{sub}</div> : null}
    </div>
  );
}

function Card({ title, kicker, children }: { title: string; kicker?: string; children: ReactNode }) {
  return (
    <section style={{ background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 18, padding: "28px 26px" }}>
      {kicker ? (
        <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: MINT, marginBottom: 8 }}>
          {kicker}
        </div>
      ) : null}
      <h2 style={{ fontFamily: display.style.fontFamily, fontWeight: 700, fontSize: 21, color: FG, margin: "0 0 18px", letterSpacing: "-0.01em" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

export default async function AnalyticsPage() {
  let data: PublicAnalytics | null = null;
  try {
    data = await getPublicAnalytics();
  } catch {
    data = null;
  }

  const maxVol = data ? Math.max(1, ...data.byDirection.map((d) => d.volumeUsd)) : 1;

  return (
    <div className={sans.className} style={{ minHeight: "100vh", background: BG, color: FG }}>
      <main style={{ maxWidth: 1080, margin: "0 auto", padding: "clamp(40px,6vw,80px) clamp(20px,5vw,40px)" }}>
        {/* Header */}
        <header style={{ marginBottom: "clamp(36px,5vw,56px)" }}>
          <a href="https://talise.io" style={{ color: DIM, textDecoration: "none", fontSize: 14, fontWeight: 600 }}>
            ← talise.io
          </a>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              marginTop: 22,
              padding: "5px 12px",
              borderRadius: 999,
              border: `1px solid ${LINE}`,
              background: "#caffb812",
              fontSize: 12,
              fontWeight: 600,
              color: MINT,
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: 999, background: MINT, display: "inline-block" }} />
            Live from Sui mainnet
          </div>
          <h1
            style={{
              fontFamily: display.style.fontFamily,
              fontWeight: 800,
              fontSize: "clamp(32px,6vw,56px)",
              letterSpacing: "-0.03em",
              lineHeight: 1.04,
              margin: "16px 0 0",
            }}
          >
            Talise in numbers
          </h1>
          <p style={{ marginTop: 14, fontSize: "clamp(15px,2.4vw,18px)", color: MUTED, maxWidth: 620, lineHeight: 1.55 }}>
            Every figure on this page is read live from production. These are real dollars settled on Sui mainnet by
            real accounts during our beta — small and honest, not rounded up.
          </p>
        </header>

        {!data ? (
          <div style={{ background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 18, padding: 40, color: MUTED }}>
            Live metrics are momentarily unavailable. Please refresh in a moment.
          </div>
        ) : (
          <>
            {/* Hero stats */}
            <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", marginBottom: 16 }}>
              <Stat value={usd(data.settled.volumeUsd)} label="Value moved on-chain" sub="Sends, swaps, cash-outs, yield" />
              <Stat value={num(data.settled.txCount)} label="On-chain transactions" sub="Gasless, sub-second finality" />
              <Stat value={num(data.settled.activeAccounts)} label="Active accounts" sub="Accounts that transacted" />
            </div>
            <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", marginBottom: 32 }}>
              <Stat value={num(data.community.accounts)} label="Accounts created" sub="zkLogin, self-custodial" />
              <Stat value={num(data.community.waitlist)} label="Waitlist + handle claims" sub="name@talise.sui" />
              <Stat value={num(data.privacy.notes)} label="Shielded notes" sub="Private transfers on mainnet" />
            </div>

            <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))" }}>
              {/* Corridors */}
              <Card kicker="Cross-border" title="Live corridors">
                {data.corridors.length === 0 ? (
                  <p style={{ color: DIM, fontSize: 14 }}>No corridor activity yet.</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {data.corridors.map((c) => (
                      <div
                        key={`${c.from}-${c.to}`}
                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderRadius: 12, background: BG, border: `1px solid ${LINE}` }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 600, fontSize: 15 }}>
                          <span>{FLAG[c.from] ?? "💱"} {c.from}</span>
                          <span style={{ color: MINT }}>→</span>
                          <span>{FLAG[c.to] ?? "💱"} {c.to}</span>
                        </div>
                        <div style={{ fontSize: 13, color: DIM }}>{num(c.count)} transfers</div>
                      </div>
                    ))}
                  </div>
                )}
                <p style={{ marginTop: 16, fontSize: 13, color: DIM, lineHeight: 1.5 }}>
                  Dollars in, local currency out — routed through licensed ramp partners and settled on-chain.
                </p>
              </Card>

              {/* Privacy pool */}
              <Card kicker="Privacy" title="Shielded pool">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <div style={{ padding: "16px", borderRadius: 12, background: BG, border: `1px solid ${LINE}` }}>
                    <div style={{ fontFamily: display.style.fontFamily, fontWeight: 800, fontSize: 30, color: MINT }}>{num(data.privacy.notes)}</div>
                    <div style={{ fontSize: 13, color: MUTED, marginTop: 6 }}>Commitments (notes deposited)</div>
                  </div>
                  <div style={{ padding: "16px", borderRadius: 12, background: BG, border: `1px solid ${LINE}` }}>
                    <div style={{ fontFamily: display.style.fontFamily, fontWeight: 800, fontSize: 30, color: MINT }}>{num(data.privacy.spent)}</div>
                    <div style={{ fontSize: 13, color: MUTED, marginTop: 6 }}>Nullifiers (notes spent)</div>
                  </div>
                </div>
                <p style={{ marginTop: 16, fontSize: 13, color: DIM, lineHeight: 1.5 }}>
                  A Groth16 zero-knowledge pool on Sui mainnet. A shielded transfer hides its amount and unlinks sender
                  from recipient.{" "}
                  <a href="https://github.com/talise-public/talise-docs/blob/main/privacy/TRUST-MODEL.md" style={{ color: MINT }}>
                    Read the trust model →
                  </a>
                </p>
              </Card>
            </div>

            {/* Activity breakdown */}
            <div style={{ marginTop: 16 }}>
              <Card kicker="Activity" title="What moves on Talise">
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {data.byDirection.map((d) => (
                    <div key={d.direction}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginBottom: 6 }}>
                        <span style={{ fontWeight: 600 }}>{DIRECTION_LABEL[d.direction] ?? d.direction}</span>
                        <span style={{ color: DIM }}>
                          {num(d.count)} txns · {usd(d.volumeUsd)}
                        </span>
                      </div>
                      <div style={{ height: 8, borderRadius: 999, background: BG, border: `1px solid ${LINE}`, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${Math.max(3, (d.volumeUsd / maxVol) * 100)}%`, background: MINT, borderRadius: 999 }} />
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            {/* Product primitives */}
            <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", marginTop: 16 }}>
              <Stat value={num(data.product.cheques)} label="Cheques issued" sub="Claimable money links" />
              <Stat value={num(data.product.streams)} label="Streams" sub="Value released by the second" />
              <Stat value={num(data.product.goals)} label="Savings goals" sub="On-chain vaults" />
            </div>

            <footer style={{ marginTop: 48, paddingTop: 24, borderTop: `1px solid ${LINE}`, display: "flex", flexWrap: "wrap", gap: 16, justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, color: DIM }}>
                Gasless · self-custodial · Sui mainnet · updated {new Date(data.updatedAt).toUTCString()}
              </span>
              <a
                href="https://testflight.apple.com/join/BFNEPYtM"
                style={{ fontSize: 14, fontWeight: 600, color: BG, background: MINT, padding: "10px 18px", borderRadius: 999, textDecoration: "none" }}
              >
                Try Talise on iOS →
              </a>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
