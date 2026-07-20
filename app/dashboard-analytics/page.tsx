import { redirect } from "next/navigation";
import { resolveAdmin } from "@/lib/admin-auth";
import AnalyticsClient from "./_components/AnalyticsClient";

export const dynamic = "force-dynamic";

export default async function DashboardAnalyticsPage() {
  const admin = await resolveAdmin();
  if (!admin) redirect("/admin/login");

  return (
    <main className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="mb-10 border-b border-[var(--color-line)] pb-8">
        <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[var(--color-accent)]">
          Analytics
        </p>
        <h1
          className="mt-3 text-[clamp(30px,5vw,44px)] leading-[1.05] text-[var(--color-fg)]"
          style={{ fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif', fontWeight: 500, letterSpacing: "-0.03em" }}
        >
          Talise network analytics
        </h1>
        <p className="mt-3 max-w-xl text-[14px] leading-relaxed text-[var(--color-fg-muted)]">
          Every Talise account and transaction, total users, stablecoin volume
          moved, and a live feed of recent transactions.
        </p>
      </header>

      <AnalyticsClient />
    </main>
  );
}
