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
  // Cream by default; a solid brand fill when tinted (mint #CAFFB8, coral
  // #FF9E7A, lilac #C9B8FF, butter #FFE59E). The hard offset shadow is the
  // signature of the v2 bento look.
  const style: CSSProperties = {
    borderRadius: radius,
    background: tint ?? "#f7fcf2",
    boxShadow: "10px 10px 0 #15300c",
  };
  const interactiveCls =
    interactive || onClick
      ? "transition-transform duration-200 ease-out hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.995] cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[#3d7a29]/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[#f7fcf2]"
      : "";
  return (
    <Tag
      onClick={onClick}
      style={style}
      className={`relative text-[#15300c] ${Tag === "button" ? "block w-full text-left" : ""} ${interactiveCls} ${className}`}
      {...(Tag === "button" ? { type: "button" as const } : {})}
    >
      {children}
    </Tag>
  );
}
