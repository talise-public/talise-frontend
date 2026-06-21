import type { ReactNode } from "react";

export type EyebrowProps = { children: ReactNode; className?: string };

/** Mono uppercase eyebrow, wide tracking, forest colour (v2 micro-label). */
export function Eyebrow({ children, className = "" }: EyebrowProps) {
  return (
    <span
      className={`font-mono text-[11px] font-medium uppercase text-[#3d7a29] ${className}`}
      style={{ letterSpacing: "0.28em" }}
    >
      {children}
    </span>
  );
}

export type MicroLabelProps = { children: ReactNode; className?: string };

/** Small mono micro-label for addresses, timestamps, secondary metadata. */
export function MicroLabel({ children, className = "" }: MicroLabelProps) {
  return (
    <span
      className={`font-mono text-[11px] text-[#3a5230] ${className}`}
      style={{ letterSpacing: "0.01em" }}
    >
      {children}
    </span>
  );
}
