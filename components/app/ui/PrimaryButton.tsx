import type { ReactNode } from "react";
import Link from "next/link";
import { Spinner } from "./Spinner";

export type PrimaryButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  loading?: boolean;
  variant?: "primary" | "ghost" | "danger";
  full?: boolean;
  type?: "button" | "submit";
};

/**
 * The app's main action button (v2). `primary` is an ink `#15300c` pill with
 * cream text that lifts on hover; `ghost` is a 2px ink-outlined pill that
 * inverts on hover; `danger` is a muted-coral outlined pill. Shows a spinner
 * while `loading`.
 */
export function PrimaryButton({
  children,
  onClick,
  href,
  disabled = false,
  loading = false,
  variant = "primary",
  full = false,
  type = "button",
}: PrimaryButtonProps) {
  // Blueprint bracket button: mono-uppercase label, forest fill (primary) /
  // hairline (ghost) / danger, with `+`-bracket corners drawn just outside.
  const variantCls =
    variant === "primary" ? "bp-btn-solid" : variant === "danger" ? "bp-btn-danger" : "bp-btn-ghost";
  const width = full ? "bp-btn-full" : "";

  const isDisabled = disabled || loading;
  const cls = `bp-btn ${variantCls} ${width} outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/55 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]`;

  const content = (
    <>
      <span aria-hidden className="bp-bracket" />
      <span aria-hidden className="bp-bracket-2" />
      {loading && <Spinner size={15} />}
      {/* inline-flex so a leading HugeIcons <svg> (which renders display:block)
          sits inline with the label instead of stacking above it. */}
      <span className={`inline-flex items-center gap-2 ${loading ? "opacity-80" : ""}`}>{children}</span>
    </>
  );

  if (href && !isDisabled) {
    return (
      <Link href={href} className={cls}>
        {content}
      </Link>
    );
  }
  return (
    <button type={type} onClick={onClick} disabled={isDisabled} className={cls} aria-busy={loading}>
      {content}
    </button>
  );
}
