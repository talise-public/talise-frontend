import type { CSSProperties, ReactNode } from "react";

export type GlassCardProps = {
  children: ReactNode;
  className?: string;
  /** Corner radius in px (generously rounded v2 bento). Default 28. */
  radius?: number;
  /** Optional solid brand fill (mint/coral/lilac/butter) instead of cream. */
  tint?: string;
  /** Adds hover lift + pressable affordance. */
  interactive?: boolean;
  onClick?: () => void;
  as?: "div" | "button";
};

/**
 * The v2 light bento card: a cream `#f7fcf2` surface with a hard offset shadow
 * (`10px 10px 0 #15300c`), generously rounded corners, ink text. This is the
 * layout workhorse the whole app composes on top of the mint page gradient.
 * Optional `tint` fills the card with a brand pop (mint/coral/lilac/butter)
 * instead of cream.
 */
export function GlassCard({
  children,
  className = "",
  radius = 28,
  tint,
  interactive = false,
  onClick,
  as,
}: GlassCardProps) {
  const Tag = (as ?? (onClick ? "button" : "div")) as "div" | "button";
  // Blueprint card: a white (or soft-tinted) surface with a crisp hairline and
  // a whisper of lift, no hard-offset bento shadow. `radius` is honoured but
  // capped tighter so cards read structured rather than pill-soft. `tint`
  // fills with a muted brand pop (mint/coral/lilac/butter).
  const style: CSSProperties = {
    borderRadius: Math.min(radius, 16),
    background: tint ?? "var(--color-surface)",
    border: "1px solid var(--color-line)",
    boxShadow: "0 1px 2px rgba(18,26,15,0.04), 0 14px 34px -22px rgba(18,26,15,0.22)",
  };
  const interactiveCls =
    interactive || onClick
      ? "transition-transform duration-200 ease-out hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.995] cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]"
      : "";
  return (
    <Tag
      onClick={onClick}
      style={style}
      className={`relative text-[var(--color-fg)] ${Tag === "button" ? "block w-full text-left" : ""} ${interactiveCls} ${className}`}
      {...(Tag === "button" ? { type: "button" as const } : {})}
    >
      {children}
    </Tag>
  );
}
