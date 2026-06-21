import type { ReactNode } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";

export type OptionRowProps = {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  badge?: string;
  onClick?: () => void;
  href?: string;
  dimmed?: boolean;
};

/**
 * A glass list row: a 40px accent-tinted icon disc, title + optional
 * subtitle, optional badge, and a trailing chevron. Renders as a link when
 * `href` is set, a button when `onClick` is set, else a static row.
 */
export function OptionRow({
  icon,
  title,
  subtitle,
  badge,
  onClick,
  href,
  dimmed = false,
}: OptionRowProps) {
  const interactive = !!(href || onClick) && !dimmed;
  const cls = `flex w-full items-center gap-3.5 rounded-2xl px-3.5 py-3 text-left transition-[transform,background-color] duration-150 ${
    interactive ? "cursor-pointer hover:-translate-y-px hover:bg-[#CAFFB8]/40" : ""
  } ${dimmed ? "opacity-55" : ""}`;

  const inner = (
    <>
      <span
        className="flex size-10 shrink-0 items-center justify-center rounded-full text-[#15300c]"
        style={{ background: "#CAFFB8" }}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium text-[#15300c]">{title}</span>
        {subtitle && <span className="block truncate text-[13px] text-[#3d7a29]">{subtitle}</span>}
      </span>
      {badge && (
        <span className="shrink-0 rounded-full border border-[#15300c]/15 bg-white/60 px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-[#3d7a29] backdrop-blur-sm">
          {badge}
        </span>
      )}
      {interactive && (
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={18}
          className="shrink-0 text-[#3d7a29]"
          strokeWidth={2}
        />
      )}
    </>
  );

  if (href && !dimmed) {
    return (
      <Link href={href} className={cls}>
        {inner}
      </Link>
    );
  }
  if (onClick && !dimmed) {
    return (
      <button type="button" onClick={onClick} className={cls}>
        {inner}
      </button>
    );
  }
  return <div className={cls}>{inner}</div>;
}
