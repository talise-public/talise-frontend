import type { ReactNode } from "react";

/** `+` crosshair centered on a grid corner. Parent must be `relative`. */
export function Tick({ corner, mint }: { corner: "tl" | "tr" | "bl" | "br"; mint?: boolean }) {
  return <span aria-hidden className={`v3-tick v3-tick-${corner} ${mint ? "v3-tick-mint" : ""}`} />;
}

/** All four corner ticks at once. `mint` for dark sections. */
export function Ticks({ mint }: { mint?: boolean } = {}) {
  return (
    <>
      <Tick corner="tl" mint={mint} />
      <Tick corner="tr" mint={mint} />
      <Tick corner="bl" mint={mint} />
      <Tick corner="br" mint={mint} />
    </>
  );
}

/** Mono eyebrow badge, ■ LABEL, the little tag above every section title. */
export function Kicker({ children }: { children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-2 border border-[var(--v3-line)] bg-[var(--v3-white)] px-3 py-1.5 text-[11px] uppercase tracking-[0.14em] text-[var(--v3-ink)]"
      style={{ fontFamily: "var(--font-mono), monospace" }}
    >
      <span className="inline-block h-2 w-2 bg-[var(--v3-accent)]" />
      {children}
    </span>
  );
}

/** Section counter, [ 02 of 08 ] · Main Features */
export function Counter({ n, label, dark }: { n: string; label: string; dark?: boolean }) {
  return (
    <div
      className={`text-[12px] uppercase tracking-[0.12em] ${dark ? "text-[#7c857f]" : "text-[var(--v3-dim)]"}`}
      style={{ fontFamily: "var(--font-mono), monospace" }}
    >
      [ <span className={dark ? "text-[#eef1ec]" : "text-[var(--v3-ink)]"}>{n}</span> of 08 ] · {label}
    </div>
  );
}

/** Bracket-cornered button (mono uppercase). */
export function BracketButton({
  href,
  children,
  variant = "solid",
  external,
}: {
  href: string;
  children: ReactNode;
  variant?: "solid" | "ghost";
  external?: boolean;
}) {
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={`v3-btn ${variant === "solid" ? "v3-btn-solid" : "v3-btn-ghost"}`}
    >
      <span aria-hidden className="v3-bracket" />
      <span aria-hidden className="v3-bracket-2" />
      {children}
    </a>
  );
}

/** Diagonal-hatch spacer band. */
export function Hatch({ h = 64 }: { h?: number }) {
  return <div aria-hidden className="v3-hatch" style={{ height: h }} />;
}
