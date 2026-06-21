import { redirect } from "next/navigation";
import { resolveAdmin } from "@/lib/admin-auth";
import AnalyticsClient from "./_components/AnalyticsClient";

export const dynamic = "force-dynamic";

export default async function DashboardAnalyticsPage() {
  const admin = await resolveAdmin();
  if (!admin) redirect("/admin/login");

  return (
    <main className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="mb-10">
        <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
          Analytics
        </p>
        <h1
          className="mt-3 text-[34px] font-[800] uppercase leading-[0.98] tracking-[-0.02em] text-[#15300c] sm:text-[44px]"
          style={{ fontFamily: "var(--font-display-v2)" }}
        >
          Talise network analytics
        </h1>
        <p className="mt-3 max-w-xl text-[14px] leading-relaxed text-[#3a5230]">
          Every Talise account and transaction — total users, stablecoin volume
          moved, and a live feed of recent transactions.
        </p>
      </header>

      <AnalyticsClient />
    </main>
  );
}
