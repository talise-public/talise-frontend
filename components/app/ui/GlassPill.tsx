import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";

export type GlassPillProps = {
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  tint?: string;
  icon?: ReactNode;
  size?: "sm" | "md";
};

/** A capsule glass chip, used for filters, quick actions, balance chips. */
export function GlassPill({
  children,
  onClick,
  href,
  tint,
  icon,
  size = "md",
}: GlassPillProps) {
  const pad = size === "sm" ? "px-3 py-1.5 text-xs gap-1.5" : "px-4 py-2 text-sm gap-2";
  const style: CSSProperties = { borderRadius: 999 };
  if (tint) {
    // A solid brand-fill chip (mint/coral/lilac/butter) with ink text, instead
    // of the default translucent glass.
    style.background = tint;
    style.color = "#15300c";
  }
  const cls = `inline-flex items-center border border-[#15300c]/15 bg-white/60 font-medium text-[#15300c] backdrop-blur-sm transition-[transform,border-color] duration-150 hover:border-[#15300c]/30 active:scale-[0.97] ${pad}`;

  const inner = (
    <>
      {icon ? <span className="inline-flex shrink-0 items-center">{icon}</span> : null}
      {children}
    </>
  );

  if (href) {
    return (
      <Link href={href} style={style} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} style={style} className={cls}>
      {inner}
    </button>
  );
}
