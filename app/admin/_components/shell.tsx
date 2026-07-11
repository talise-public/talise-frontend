"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import type { AdminVia } from "@/lib/admin-auth";

/**
 * Dashboard chrome: fixed left sidebar nav + top bar with the auth mode
 * and a logout button. Every gated page renders inside this shell. The
 * nav lists all sections so it's complete regardless of which page
 * module has shipped yet.
 */

const NAV: Array<{ href: string; label: string; hint: string }> = [
  { href: "/admin", label: "Overview", hint: "KPIs across the whole DB" },
  { href: "/admin/users", label: "Users", hint: "Accounts, KYC tiers, balances" },
  { href: "/admin/transactions", label: "Transactions", hint: "On-chain + cross-border + payouts" },
  { href: "/admin/waitlist", label: "Waitlist", hint: "Signups + handle claims" },
  { href: "/admin/compliance", label: "Compliance", hint: "KYC intents, Travel Rule, float" },
  { href: "/admin/ledger", label: "Ledger", hint: "Rewards, goals, invoices" },
  { href: "/admin/raw", label: "Raw DB", hint: "Every table, read-only" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(href + "/");
}

export function AdminShell({ via, children }: { via: AdminVia; children: ReactNode }) {
  const pathname = usePathname() ?? "/admin";
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch("/api/admin/auth", { method: "DELETE" });
    } catch {
      /* ignore */
    }
    router.push("/admin/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-bg text-fg">
      <div className="flex w-full">
        {/* Sidebar */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface/40 p-4 md:flex">
          <div className="mb-6 flex items-center gap-2 px-2">
            <span className="h-2.5 w-2.5 rounded-full bg-accent" />
            <span className="font-mono text-sm font-semibold tracking-tight text-fg">
              Talise Admin
            </span>
          </div>
          <nav className="flex flex-1 flex-col gap-0.5">
            {NAV.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`group rounded-lg px-3 py-2 transition ${
                    active
                      ? "bg-accent-deep/15 text-accent"
                      : "text-fg-muted hover:bg-surface-2 hover:text-fg"
                  }`}
                >
                  <span className="block text-sm font-medium">{item.label}</span>
                  <span className="block text-[11px] text-fg-dim">{item.hint}</span>
                </Link>
              );
            })}
          </nav>
          <div className="mt-4 border-t border-line pt-4">
            <div className="px-2 text-[11px] text-fg-dim">
              auth:{" "}
              <span className={via === "dev" ? "text-amber-400" : "text-accent"}>{via}</span>
            </div>
            {via !== "dev" ? (
              <button
                type="button"
                onClick={logout}
                disabled={loggingOut}
                className="mt-2 w-full rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs text-fg-muted hover:text-fg disabled:opacity-50"
              >
                {loggingOut ? "Logging out…" : "Log out"}
              </button>
            ) : null}
          </div>
        </aside>

        {/* Main */}
        <div className="min-w-0 flex-1">
          {/* Mobile nav */}
          <div className="flex items-center gap-2 overflow-x-auto border-b border-line bg-surface/40 px-3 py-2 md:hidden">
            {NAV.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`whitespace-nowrap rounded-md px-2.5 py-1 text-xs ${
                    active ? "bg-accent-deep/15 text-accent" : "text-fg-muted"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>

          {via === "dev" ? (
            <div className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-center text-xs text-amber-300">
              DEV — unauthenticated access (no ADMIN_TOKEN set). Set ADMIN_TOKEN in your env to
              require a login.
            </div>
          ) : null}

          <main className="px-5 py-6 sm:px-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
