import { redirect } from "next/navigation";
import { resolveAdmin } from "@/lib/admin-auth";
import { readSessionEntryId } from "@/lib/session";
import { userById } from "@/lib/db";
import { readBalanceSnapshot } from "@/lib/snapshots";
import { AppShell, BUSINESS_NAV } from "@/components/app/AppShell";
import type { Me, Balances } from "@/components/app/data";

export const dynamic = "force-dynamic";

/**
 * /business shell + gate, the business workspace.
 *
 * Same gate + session resolution as /app, but drives the AppShell with the
 * BUSINESS_NAV config (Dashboard / Invoices / Team / Pay / Activity). The
 * OAuth callback routes account_type === "business" users here; personal
 * accounts land on /app. Both surfaces share the same wallet + data layer.
 */
export default async function BusinessLayout({ children }: { children: React.ReactNode }) {
  if (!(await resolveAdmin())) {
    redirect("/admin/login");
  }

  let me: Me | null = null;
  let initialBalances: Balances | null = null;
  const id = await readSessionEntryId();
  if (id != null) {
    const u = await userById(id).catch(() => null);
    if (u) {
      me = {
        id: String(u.id),
        email: u.email,
        name: u.name,
        picture: u.picture,
        country: u.country,
        suiAddress: u.sui_address,
        taliseHandle: u.talise_username,
        accountType: u.account_type ?? "personal",
      };
      const snap = await readBalanceSnapshot(id).catch(() => null);
      if (snap) {
        initialBalances = {
          address: snap.suiAddress,
          usdsui: snap.usdsui,
          sui: snap.sui,
          suiPriceUsd: snap.suiPriceUsd,
          totalUsd: snap.totalUsd,
          refreshedAt: snap.refreshedAt,
          stale: true,
        };
      }
    }
  }

  return (
    <AppShell me={me} initialBalances={initialBalances} nav={BUSINESS_NAV}>
      {children}
    </AppShell>
  );
}
