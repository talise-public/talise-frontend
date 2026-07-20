import PublicAnalyticsClient from "./_components/PublicAnalyticsClient";

// Public network analytics — the old dashboard layout (totals + a live feed of
// every on-chain Talise transaction), open to anyone (no admin gate). The
// admin-only controls (Index now) live on /dashboard-analytics.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Talise, network analytics",
  description:
    "Every Talise account and transaction on Sui — total users, stablecoin volume moved, and a live feed of recent on-chain transactions.",
};

export default function AnalyticsPage() {
  return (
    <main className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="mb-10 border-b border-[var(--color-line)] pb-8">
        <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[var(--color-accent)]">
          Analytics
        </p>
        <h1
          className="mt-3 text-[clamp(30px,5vw,44px)] leading-[1.05] text-[var(--color-fg)]"
          style={{
            fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif',
            fontWeight: 500,
            letterSpacing: "-0.03em",
          }}
        >
          Talise network analytics
        </h1>
        <p className="mt-3 max-w-xl text-[14px] leading-relaxed text-[var(--color-fg-muted)]">
          Every Talise account and transaction, total users, stablecoin volume
          moved, and a live feed of recent transactions.
        </p>
      </header>

      <PublicAnalyticsClient />
    </main>
  );
}
