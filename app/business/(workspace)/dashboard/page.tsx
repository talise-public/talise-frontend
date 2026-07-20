"use client";

/**
 * /business, the business dashboard.
 *
 * Same wallet + data layer as /app, framed for a business: balance + payable
 * identity up top, then the three things a business does most (invoice a
 * client, pay the team, cash out), then recent activity. Renders inside the
 * BUSINESS_NAV AppShell mounted by app/business/layout.tsx.
 */

import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { Invoice01Icon, UserGroupIcon, BankIcon } from "@hugeicons/core-free-icons";
import { useMe, Eyebrow } from "@/components/app";
import { BalanceHero, IdentityCard, RecentActivity } from "@/components/app/home";
import type { IconSvgElement } from "@hugeicons/react";

export default function BusinessDashboard() {
  const { me } = useMe();
  const first = (me?.name ?? "").trim().split(/\s+/)[0];

  return (
    <div className="space-y-6">
      {/* Page header, eyebrow + title + subtitle, tight and intentional. */}
      <header className="lg:pt-1">
        <Eyebrow>Business</Eyebrow>
        <h1
          className="mt-1 text-[22px] sm:text-[24px]"
          style={{
            fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif',
            fontWeight: 500,
            letterSpacing: "-0.03em",
            color: "var(--color-fg)",
          }}
        >
          {first ? `${first}'s workspace` : "Your workspace"}
        </h1>
        <p className="mt-0.5 text-[13px] text-fg-muted">
          Invoice clients, pay your team, and move money, all in USDsui.
        </p>
      </header>

      {/* Balance card + identity card, equal height, mirroring consumer Home. */}
      <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-[1.4fr_1fr] lg:items-stretch lg:gap-5">
        <BalanceHero />
        <IdentityCard me={me} />
      </div>

      {/* The three core business actions, compact Wise-style tiles. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <ActionTile
          href="/business/invoices"
          icon={Invoice01Icon as IconSvgElement}
          title="Invoice clients"
          blurb="Send a pay link, money lands instantly."
        />
        <ActionTile
          href="/business/team"
          icon={UserGroupIcon as IconSvgElement}
          title="Pay your team"
          blurb="Streamed salaries, funded once."
        />
        <ActionTile
          href="/business/ramps"
          icon={BankIcon as IconSvgElement}
          title="Cash out"
          blurb="USDsui to your bank, via Linq."
        />
      </div>

      <RecentActivity />
    </div>
  );
}

/**
 * Compact action tile, icon chip (accent-soft, rectangular hairline) + title
 * + blurb. Engineering-blueprint pattern: flat white card, hairline border,
 * hover accent border. No heavy shadows, no gradients.
 */
function ActionTile({
  href,
  icon,
  title,
  blurb,
}: {
  href: string;
  icon: IconSvgElement;
  title: string;
  blurb: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-[10px] border border-line bg-surface p-5 transition-[border-color,transform] duration-150 hover:-translate-y-px hover:border-[color-mix(in_srgb,var(--color-accent-deep)_40%,var(--color-line))] active:translate-y-0 active:scale-[0.99]"
    >
      {/* Icon chip, rectangular, accent-soft fill, accent icon colour. */}
      <span className="flex size-10 items-center justify-center rounded-[8px] bg-accent-soft text-accent">
        <HugeiconsIcon icon={icon} size={19} strokeWidth={1.9} />
      </span>
      <h2
        className="mt-3.5 text-[15px] text-fg"
        style={{
          fontFamily: '"TWK Everett", var(--font-display-v2), system-ui, sans-serif',
          fontWeight: 500,
          letterSpacing: "-0.02em",
        }}
      >
        {title}
      </h2>
      <p className="mt-0.5 text-[13px] leading-snug text-fg-muted">{blurb}</p>
    </Link>
  );
}
