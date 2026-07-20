import { type ElementType, type ReactNode } from "react";

/**
 * Scroll-reveal marker. Renders `.v3-reveal` (hidden by default in v3.css); the
 * global <Motion /> controller batches these and animates them in with GSAP as
 * they enter the viewport. `delay` is kept for call-site intent / ordering but
 * the batch stagger drives the actual sequencing.
 */
export default function Reveal({
  children,
  as: Tag = "div",
  className = "",
  delay = 0,
  style,
}: {
  children: ReactNode;
  as?: ElementType;
  className?: string;
  delay?: number;
  style?: React.CSSProperties;
}) {
  return (
    <Tag className={`v3-reveal ${className}`} data-reveal-delay={delay || undefined} style={style}>
      {children}
    </Tag>
  );
}
