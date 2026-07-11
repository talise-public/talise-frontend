"use client";

/**
 * The responsive app chrome.
 *
 *   lg+   →  240px fixed left sidebar (logo, primary nav, divider, secondary
 *            nav, footer account chip + currency picker) + a max-w content
 *            column with a slim topbar (page title, balance chip, account).
 *   <lg   →  a top mini-bar (logo, balance chip, avatar menu) + content + a
 *            floating bottom glass nav pill with the 5 primary items.
 *
 * When `me == null` it renders a centered sign-in screen instead of the app.
 * Mounts <CurrencyProvider> + <ToastProvider> for everything beneath it.
 */

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Home09Icon,
  ArrowDataTransferHorizontalIcon,
  Plant02Icon,
  Briefcase01Icon,
  Analytics01Icon,
  Settings01Icon,
  CreditCardIcon,
  Logout01Icon,
  UserIcon,
  Invoice01Icon,
  UserGroupIcon,
  BarcodeScanIcon,
  MoneyReceive01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { CurrencyProvider, useCurrency } from "./data/currency";
import { Flag } from "./ui";
import { ToastProvider } from "./data/toast";
import { useBalances, seedResource, type Me, type Balances } from "./data";
import {
  triggerOauthSignIn,
  clearStored,
  clearExpiryMarker,
  readEphemeralForT2000,
  writeCachedProof,
  type StoredZkProof,
} from "@/lib/zkclient";
import { api } from "./data/api";
import { forceFreshSignIn, signingSessionExpired } from "@/lib/session-expiry";
import { Diamond } from "@/components/Diamond";
import { ScanSheet } from "./scan/ScanSheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { IconSvgElement } from "@hugeicons/react";

type NavItem = {
  label: string;
  href: string;
  icon: IconSvgElement;
  /**
   * Optional sub-entries revealed in the desktop sidebar when this item (or
   * one of its children) is the active section. Used to surface Pay's sibling
   * routes (Cheques, Stream, Request) that otherwise have no nav entry point.
   */
  children?: Array<{ label: string; href: string }>;
};

const PRIMARY: NavItem[] = [
  { label: "Home", href: "/app", icon: Home09Icon as IconSvgElement },
  {
    label: "Pay",
    href: "/app/pay",
    icon: ArrowDataTransferHorizontalIcon as IconSvgElement,
    children: [
      { label: "Send", href: "/app/pay" },
      { label: "Request", href: "/app/pay/request" },
      { label: "Cheques", href: "/app/pay/cheques" },
      { label: "Stream", href: "/app/pay/stream" },
    ],
  },
  { label: "Copilot", href: "/app/agent", icon: SparklesIcon as IconSvgElement },
  { label: "Earn", href: "/app/earn", icon: Plant02Icon as IconSvgElement },
  { label: "Work", href: "/app/work", icon: Briefcase01Icon as IconSvgElement },
  { label: "Activity", href: "/app/activity", icon: Analytics01Icon as IconSvgElement },
];

const PAGE_TITLES: Record<string, string> = {
  "/app": "Home",
  "/app/pay": "Pay",
  "/app/pay/request": "Request",
  "/app/pay/cheques": "Cheques",
  "/app/pay/stream": "Stream",
  "/app/agent": "Copilot",
  "/app/requests": "Requests",
  "/app/rules": "Automations",
  "/app/earn": "Earn",
  "/app/rewards": "Rewards",
  "/app/work": "Work",
  "/app/activity": "Activity",
  "/app/ramps": "Ramps",
  "/app/settings": "Settings",
};

/**
 * Nav configuration — lets one shell drive two surfaces: the consumer wallet
 * (/app) and the business workspace (/business). Everything route-specific
 * (brand target, primary nav, ramps/settings links, page titles, sign-in
 * return) lives here so the chrome stays identical and in sync.
 */
export type NavConfig = {
  brandHref: string;
  primary: NavItem[];
  rampsHref: string;
  settingsHref: string;
  titles: Record<string, string>;
  signInReturnTo: string;
};

export const CONSUMER_NAV: NavConfig = {
  brandHref: "/app",
  primary: PRIMARY,
  rampsHref: "/app/ramps",
  settingsHref: "/app/settings",
  titles: PAGE_TITLES,
  signInReturnTo: "/app",
};

export const BUSINESS_NAV: NavConfig = {
  brandHref: "/business/dashboard",
  primary: [
    { label: "Dashboard", href: "/business/dashboard", icon: Home09Icon as IconSvgElement },
    { label: "Invoices", href: "/business/invoices", icon: Invoice01Icon as IconSvgElement },
    { label: "Team", href: "/business/team", icon: UserGroupIcon as IconSvgElement },
    { label: "Pay", href: "/business/pay", icon: ArrowDataTransferHorizontalIcon as IconSvgElement },
    { label: "Activity", href: "/business/activity", icon: Analytics01Icon as IconSvgElement },
  ],
  rampsHref: "/business/ramps",
  settingsHref: "/business/settings",
  titles: {
    "/business/dashboard": "Dashboard",
    "/business/invoices": "Invoices",
    "/business/team": "Team",
    "/business/pay": "Pay",
    "/business/activity": "Activity",
    "/business/ramps": "Ramps",
    "/business/settings": "Settings",
  },
  signInReturnTo: "/business/dashboard",
};

function isActive(pathname: string, href: string, brandHref: string): boolean {
  if (href === brandHref) return pathname === brandHref;
  return pathname === href || pathname.startsWith(href + "/");
}

// ── Brand mark ─────────────────────────────────────────────────────────────

function Logo({ compact = false, homeHref = "/app" }: { compact?: boolean; homeHref?: string }) {
  // The real Talise brand mark (the pinwheel from public/symbol.svg), forest-
  // tinted via --color-accent — identical to the landing TopBar wordmark.
  return (
    <Link href={homeHref} className="inline-flex items-center gap-2">
      <Diamond />
      {!compact && (
        <span
          className="text-[19px] font-[800] lowercase tracking-[-0.03em] text-[#15300c]"
          style={{ fontFamily: "var(--font-display-v2)" }}
        >
          talise
        </span>
      )}
      {/* Private-beta marker — a small chip so testers always know
          they're on the beta surface. */}
      <span className="rounded-[6px] bg-[#CAFFB8] px-1.5 py-[3px] font-mono text-[9px] font-semibold uppercase leading-none tracking-[0.18em] text-[#15300c]">
        Beta
      </span>
    </Link>
  );
}

// ── Balance chip ─────────────────────────────────────────────────────────────

function BalanceChip({ homeHref = "/app" }: { homeHref?: string }) {
  const { data, loading, error } = useBalances();
  const { formatUsd } = useCurrency();
  return (
    <Link
      href={homeHref}
      className="inline-flex items-center gap-2 rounded-full border border-[#15300c]/15 bg-white/60 px-3 py-1.5 backdrop-blur-sm transition-colors hover:border-[#15300c]/30"
    >
      <span className="size-1.5 rounded-full" style={{ background: "#3d7a29" }} />
      <span className="text-[13px] font-semibold tabular-nums text-[#15300c]" style={{ letterSpacing: "-0.01em" }}>
        {!data && (loading || error) ? "—" : formatUsd(data?.totalUsd ?? 0)}
      </span>
    </Link>
  );
}

// ── Currency select ─────────────────────────────────────────────────────────

function CurrencySelect() {
  const { currency, setCurrency, currencies } = useCurrency();
  return (
    <Select value={currency} onValueChange={setCurrency}>
      <SelectTrigger
        aria-label="Display currency"
        className="h-auto w-fit max-w-full self-start rounded-full border border-[#15300c]/15 bg-white/60 px-3 py-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-[#3d7a29] shadow-none backdrop-blur-sm"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-72 rounded-2xl border border-[#15300c]/10 bg-[#f7fcf2] text-[#15300c]">
        {currencies.map((c) => (
          <SelectItem
            key={c.code}
            value={c.code}
            className="font-mono text-[12px] uppercase tracking-wide"
          >
            <Flag code={c.code} size={15} className="mr-1.5 align-middle" /> {c.code} · {c.symbol}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── Account chip / avatar ─────────────────────────────────────────────────────

function Avatar({ me, size = 28 }: { me: Me; size?: number }) {
  const initial = (me.name ?? me.email ?? "?").trim().charAt(0).toUpperCase();
  // Google avatar URLs (lh3.googleusercontent.com) regularly 403/expire —
  // without an error fallback the chip rendered as a broken-image glyph.
  const [imgFailed, setImgFailed] = useState(false);
  if (me.picture && !imgFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={me.picture}
        alt={me.name ?? "Account"}
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        onError={() => setImgFailed(true)}
        className="rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="flex items-center justify-center rounded-full text-[12px] font-semibold text-[#f7fcf2]"
      style={{ width: size, height: size, background: "#3d7a29" }}
    >
      {initial}
    </span>
  );
}

function accountLabel(me: Me): string {
  if (me.taliseHandle) return `${me.taliseHandle}@talise`;
  return me.name ?? me.email;
}

// ── Sidebar nav item (lg+) ─────────────────────────────────────────────────────

function SidebarItem({ item, active, dimmed, badge }: { item: NavItem; active: boolean; dimmed?: boolean; badge?: string }) {
  const content = (
    <>
      <HugeiconsIcon
        icon={item.icon}
        size={19}
        strokeWidth={active ? 2.2 : 1.8}
        color={active ? "#f7fcf2" : "#3a5230"}
      />
      <span className={`flex-1 text-[14px] font-medium ${active ? "font-semibold text-[#f7fcf2]" : "text-[#3a5230]"}`}>
        {item.label}
      </span>
      {badge && (
        <span className="rounded-full border border-[#15300c]/15 bg-white/70 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-[#3d7a29]">
          {badge}
        </span>
      )}
    </>
  );
  const cls = `flex items-center gap-3 rounded-2xl px-3 py-2.5 transition-colors ${
    active ? "bg-[#3d7a29] shadow-[0_6px_18px_-8px_rgba(21,48,12,0.5)]" : "hover:bg-[#CAFFB8]/60"
  } ${dimmed ? "opacity-55" : ""}`;
  if (dimmed) {
    return (
      <div className={cls} aria-disabled>
        {content}
      </div>
    );
  }
  return (
    <Link href={item.href} className={cls}>
      {content}
    </Link>
  );
}

// ── Sign-in screen ─────────────────────────────────────────────────────────────

function SignInScreen({ returnTo = "/app" }: { returnTo?: string }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6">
      <div
        className="w-full max-w-sm rounded-[28px] bg-[#f7fcf2] p-8 text-center"
        style={{ boxShadow: "10px 10px 0 #15300c" }}
      >
        <div className="mx-auto mb-6 flex scale-[1.4] justify-center">
          <Logo compact />
        </div>
        <h1
          className="text-[26px] font-[800] uppercase tracking-[-0.02em] text-[#15300c]"
          style={{ fontFamily: "var(--font-display-v2)" }}
        >
          Talise
        </h1>
        <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">Beta</p>
        <p className="mx-auto mt-4 max-w-[16rem] text-[14px] leading-relaxed text-[#3a5230]">
          A gasless dollar wallet on Sui. Sign in to send, save, and get paid, no gas, no seed phrase.
        </p>
        <button
          type="button"
          onClick={() => triggerOauthSignIn({ returnTo })}
          className="mt-7 inline-flex w-full items-center justify-center gap-3 rounded-full bg-[#15300c] px-5 py-3 text-[15px] font-semibold text-[#f7fcf2] transition-transform duration-150 hover:-translate-y-0.5 active:scale-[0.98]"
        >
            {/* Real Google "G" (official brand colors) on a white disc so the
                multicolor mark reads on the green button. */}
            <span className="flex size-6 items-center justify-center rounded-full bg-white">
              <svg width="14" height="14" viewBox="0 0 48 48" aria-hidden>
                <path
                  fill="#EA4335"
                  d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                />
                <path
                  fill="#4285F4"
                  d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                />
                <path
                  fill="#FBBC05"
                  d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                />
                <path
                  fill="#34A853"
                  d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                />
              </svg>
            </span>
          Continue with Google
        </button>
      </div>
      <p className="mt-6 text-center font-mono text-[11px] uppercase tracking-[0.28em] text-[#3d7a29]">
        Invite-only beta · by Talise
      </p>
    </div>
  );
}

// ── Account dropdown (Radix DropdownMenu) ──────────────────────────────────────

function AccountMenu({
  me,
  size = 32,
  activityHref = "/app/activity",
  rampsHref = "/app/ramps",
  showMoneyTools = false,
}: {
  me: Me;
  size?: number;
  activityHref?: string;
  rampsHref?: string;
  /** Consumer-only: surface Requests + Automations (no sidebar on mobile). */
  showMoneyTools?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className="rounded-full outline-none ring-1 ring-[#15300c]/15 transition-transform active:scale-95 focus-visible:ring-2 focus-visible:ring-[#3d7a29]/45"
      >
        <Avatar me={me} size={size} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-56 rounded-2xl border border-[#15300c]/10 bg-[#f7fcf2] text-[#15300c]">
        <DropdownMenuLabel className="flex items-center gap-3 px-2 py-1.5">
          <Avatar me={me} size={34} />
          <div className="min-w-0">
            <div className="truncate text-[14px] font-medium text-[#15300c]">{accountLabel(me)}</div>
            <div className="truncate text-[12px] font-normal text-[#3d7a29]">{me.email}</div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* Activity ⇄ Settings swap (mobile): Settings now sits in the bottom
            tab bar; Activity lives here instead. */}
        <DropdownMenuItem asChild>
          <Link href={activityHref}>
            <HugeiconsIcon icon={Analytics01Icon} size={18} strokeWidth={1.8} /> Activity
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={rampsHref}>
            <HugeiconsIcon icon={CreditCardIcon} size={18} strokeWidth={1.8} /> Add money & cash out
          </Link>
        </DropdownMenuItem>
        {showMoneyTools && (
          <>
            <DropdownMenuItem asChild>
              <Link href="/app/requests">
                <HugeiconsIcon icon={MoneyReceive01Icon} size={18} strokeWidth={1.8} /> Requests
              </Link>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          {/* Wipe the tab's ephemeral key + cross-tab expiry marker BEFORE the
              cookie teardown so no zk material outlives the session. */}
          <a href="/auth/logout" onClick={() => { clearStored(); clearExpiryMarker(); }}>
            <HugeiconsIcon icon={Logout01Icon} size={18} strokeWidth={1.8} /> Sign out
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Shell body (inside providers) ─────────────────────────────────────────────

function ShellBody({ me, nav, children }: { me: Me; nav: NavConfig; children: ReactNode }) {
  const pathname = usePathname() ?? nav.brandHref;
  // Mobile scan-to-pay overlay (header button below).
  const [scanOpen, setScanOpen] = useState(false);

  return (
    <div className="relative min-h-screen text-[#15300c]">
      {/* ── Desktop sidebar (lg+) ── */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-[#15300c]/10 px-4 py-5 lg:flex">
        <div className="px-2">
          <Logo homeHref={nav.brandHref} />
        </div>
        <nav className="mt-7 flex flex-1 flex-col gap-1">
          {nav.primary.map((item) => {
            const active = isActive(pathname, item.href, nav.brandHref);
            return (
              <div key={item.href}>
                <SidebarItem item={item} active={active} />
                {/* Reveal sub-entries (e.g. Pay → Cheques/Stream/Request)
                    only while this section is active, so the sidebar stays
                    calm elsewhere but those routes are reachable here. */}
                {item.children && active && (
                  <div className="mb-1.5 ml-[26px] mt-1 flex flex-col gap-0.5 border-l border-[#15300c]/15 pl-2">
                    {item.children.map((child) => {
                      const childActive =
                        child.href === item.href
                          ? pathname === child.href
                          : pathname === child.href ||
                            pathname.startsWith(child.href + "/");
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          aria-current={childActive ? "page" : undefined}
                          className={`rounded-xl px-2.5 py-1.5 text-[13px] transition-colors ${
                            childActive
                              ? "bg-[#CAFFB8] font-semibold text-[#15300c]"
                              : "font-medium text-[#3a5230] hover:bg-[#CAFFB8]/50 hover:text-[#15300c]"
                          }`}
                        >
                          {child.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          <div className="my-3 h-px bg-[#15300c]/10" />
          {/* Secondary money tools — Requests (track who owes you). Consumer
              surface only; the business nav has its own primary set so these
              stay out of it. (Automations hidden for now.) */}
          {nav === CONSUMER_NAV && (
            <>
              <SidebarItem
                item={{ label: "Requests", href: "/app/requests", icon: MoneyReceive01Icon as IconSvgElement }}
                active={isActive(pathname, "/app/requests", nav.brandHref)}
              />
            </>
          )}
          <SidebarItem
            item={{ label: "Ramps", href: nav.rampsHref, icon: CreditCardIcon as IconSvgElement }}
            active={isActive(pathname, nav.rampsHref, nav.brandHref)}
          />
          <SidebarItem
            item={{ label: "Settings", href: nav.settingsHref, icon: Settings01Icon as IconSvgElement }}
            active={isActive(pathname, nav.settingsHref, nav.brandHref)}
          />
        </nav>
        <div className="mt-4 flex flex-col gap-3">
          <CurrencySelect />
          <Link
            href={nav.settingsHref}
            className="flex items-center gap-2.5 rounded-2xl border border-[#15300c]/15 bg-white/60 px-3 py-2.5 backdrop-blur-sm transition-colors hover:border-[#15300c]/30"
          >
            <Avatar me={me} size={30} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-[#15300c]">{accountLabel(me)}</div>
              <div className="truncate font-mono text-[10px] text-[#3d7a29]">
                {me.suiAddress.slice(0, 6)}…{me.suiAddress.slice(-4)}
              </div>
            </div>
          </Link>
        </div>
      </aside>

      {/* ── Main area ── (no desktop topbar — the sidebar shows the active
          page; content leads, Wise-style) */}
      <div className="relative z-10 lg:pl-60">
        {/* Mobile mini-bar — transparent, sits on the mint gradient and scrolls
            away with the content (no bar background / border). */}
        {/* Wordmark + a single profile chip (Avatar with initials fallback —
            the dropdown carries Ramps, Settings, and sign-out, which is how
            those surfaces stay reachable on mobile). The balance chip stays
            removed — the balance lives on the page itself. */}
        <header className="relative z-30 flex items-center justify-between px-4 pb-1 pt-3 lg:hidden">
          <Logo homeHref={nav.brandHref} />
          <div className="flex items-center gap-2.5">
            {/* Scan-to-pay — camera QR reader routing into Send with the
                recipient prefilled (mobile-only entry; desktop has no camera
                ergonomics worth the chrome). */}
            <button
              type="button"
              onClick={() => setScanOpen(true)}
              aria-label="Scan to pay"
              className="flex size-9 items-center justify-center rounded-full border border-[#15300c]/15 bg-white/60 text-[#15300c] backdrop-blur-sm"
            >
              <HugeiconsIcon icon={BarcodeScanIcon} size={17} strokeWidth={1.9} />
            </button>
            <AccountMenu
              me={me}
              activityHref={
                nav.primary.find((i) => i.label === "Activity")?.href ?? "/app/activity"
              }
              rampsHref={nav.rampsHref}
              showMoneyTools={nav === CONSUMER_NAV}
            />
          </div>
        </header>
        <ScanSheet open={scanOpen} onClose={() => setScanOpen(false)} />

        {/* Content column. overflow-x-clip: belt-and-braces — no child (wide
            grid item, unbreakable number, slider) can ever drag the page into
            horizontal scroll on mobile. */}
        {/* pt-7 on mobile: a deliberate, consistent breath between the mini
            header and every page's first element (Earn/Work/Settings sat too
            tight at pt-4). Desktop keeps its taller lg:pt-16. */}
        <main className="mx-auto w-full min-w-0 max-w-[1040px] overflow-x-clip px-4 pb-32 pt-7 sm:px-6 lg:px-8 lg:pb-12 lg:pt-16">
          {children}
        </main>
      </div>

      {/* ── Mobile bottom nav ── */}
      {/* Activity ⇄ Settings swap (mobile only): Settings takes Activity's
          tab slot here; Activity moves into the avatar dropdown (AccountMenu).
          The desktop sidebar keeps Activity in the primary list. */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4 lg:hidden">
        <div className="flex items-center gap-1 rounded-full border border-[#15300c]/10 bg-white/85 px-2 py-2 shadow-[0_10px_40px_-12px_rgba(21,48,12,0.35)] backdrop-blur-md" style={{ borderRadius: 999 }}>
          {nav.primary
            .map((item) =>
              item.label === "Activity"
                ? { label: "Settings", href: nav.settingsHref, icon: Settings01Icon as IconSvgElement }
                : item
            )
            .map((item) => {
            const active = isActive(pathname, item.href, nav.brandHref);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-label={item.label}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-0.5 rounded-full px-3.5 py-1.5 transition-colors ${
                  active ? "bg-[#CAFFB8]" : ""
                }`}
              >
                <HugeiconsIcon
                  icon={item.icon}
                  size={20}
                  strokeWidth={active ? 2.2 : 1.8}
                  color={active ? "#15300c" : "#3a5230"}
                />
                <span className={`text-[10px] font-medium ${active ? "font-semibold text-[#15300c]" : "text-[#3a5230]"}`}>
                  {item.label}
                </span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

// ── Public AppShell ─────────────────────────────────────────────────────────

export type AppShellProps = {
  me: Me | null;
  initialBalances?: Balances | null;
  /** Drives consumer (/app) vs business (/business) chrome. Default: consumer. */
  nav?: NavConfig;
  children: ReactNode;
};

export function AppShell({ me, initialBalances, nav = CONSUMER_NAV, children }: AppShellProps) {
  // Expired-session watcher: once the zkLogin signing window lapses, sign the
  // user OUT for a clean re-sign-in instead of leaving a half-session that
  // renders pages but can't sign (see lib/session-expiry.ts). Checked on
  // mount, on tab focus, and every 60s while open.
  const signedIn = !!me;
  useEffect(() => {
    if (!signedIn) return;
    let done = false;
    const check = () => {
      if (!done && signingSessionExpired()) {
        done = true; // one teardown only
        void forceFreshSignIn();
      }
    };
    check();
    const onVis = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVis);
    const t = window.setInterval(check, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(t);
    };
  }, [signedIn]);

  // ── Send-path warmers (launch-day perf, 2026-06-11) ────────────────
  // iOS hits /api/zk/warmup at dashboard load; the web never did — so a
  // web user's FIRST send paid the full cold path inline: Onara status,
  // gas price, NAVI pools, payment registry, epoch/chain memos, AND the
  // 2–4s Shinami proof mint. Warm all of it once per app mount:
  //   1. /api/zk/warmup — server-side caches (fire-and-forget).
  //   2. /api/zk/proof — pre-mints the zkLogin proof and stores it next
  //      to the ephemeral key, so sponsor-execute skips the prover hop.
  useEffect(() => {
    if (!signedIn) return;
    void fetch("/api/zk/warmup", { method: "POST" }).catch(() => {});
    const eph = readEphemeralForT2000();
    if (eph && !eph.cachedProof) {
      void api<{ proof: StoredZkProof }>("/api/zk/proof", {
        method: "POST",
        body: {
          ephemeralPubKeyB64: eph.ephemeralPubKeyB64,
          maxEpoch: eph.maxEpoch,
          randomness: eph.randomness,
        },
      })
        .then((r) => {
          if (r?.proof) writeCachedProof(r.proof);
        })
        .catch(() => {
          /* best-effort — the send path mints inline as before */
        });
    }
  }, [signedIn]);

  if (!me) {
    return <SignInScreen returnTo={nav.signInReturnTo} />;
  }
  // Seed the client caches from what the layout already resolved server-side, so
  // useMe()/useBalances() render correct values INSTANTLY with no round-trip on
  // load (the @handle + the balance hero). Idempotent; the client still
  // revalidates fresh afterwards.
  seedResource("/api/me", me);
  if (initialBalances) seedResource("/api/balances", initialBalances);
  return (
    <CurrencyProvider>
      <ToastProvider>
        <ShellBody me={me} nav={nav}>{children}</ShellBody>
      </ToastProvider>
    </CurrencyProvider>
  );
}

export default AppShell;
