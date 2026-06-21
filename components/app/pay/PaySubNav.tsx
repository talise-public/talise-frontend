"use client";

/**
 * PaySubNav — the sub-navigation pill row for the Pay area.
 *
 * The Pay landing (/app/pay) is the Send flow; Request, Cheques (claimable
 * links) and Stream (streamed payouts) live on sibling routes that previously
 * had NO in-app entry point. This row makes all four reachable, matching the
 * AppShell glass-pill nav style (talise-glass rounded-full, accent-soft active
 * state). Active state is derived from the current pathname.
 *
 * Text-only labels (no icons): the founder asked for a quieter, less noisy Pay
 * page — the four icon+label pills read as competing chrome. Plain labels in
 * pills keep navigation clear without the visual weight.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { label: string; href: string; exact?: boolean };

const ITEMS: Item[] = [
  { label: "Send", href: "/app/pay", exact: true },
  { label: "Request", href: "/app/pay/request" },
  { label: "Cheques", href: "/app/pay/cheques" },
  { label: "Stream", href: "/app/pay/stream" },
];

function isActive(pathname: string, item: Item): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(item.href + "/");
}

export function PaySubNav() {
  const pathname = usePathname() ?? "/app/pay";
  return (
    // MOBILE-ONLY: on desktop the sidebar already expands Pay into the same
    // Send/Request/Cheques/Stream children, so this pill row would be redundant
    // (lg:hidden). On mobile the sidebar is hidden and the bottom-nav doesn't
    // expand Pay, so this is the only sub-nav.
    <nav className="mb-4 flex w-full justify-center sm:justify-start lg:hidden">
      <div className="flex items-center gap-1 rounded-full border border-[#15300c]/10 bg-white/85 px-1.5 py-1.5 shadow-[0_10px_40px_-12px_rgba(21,48,12,0.35)] backdrop-blur-md">
        {ITEMS.map((item) => {
          const active = isActive(pathname, item);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
                active ? "bg-[#CAFFB8] text-[#15300c]" : "text-[#3a5230] hover:bg-[#CAFFB8]/50"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export default PaySubNav;
