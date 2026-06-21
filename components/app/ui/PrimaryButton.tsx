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
  const base =
    "relative inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-[15px] font-semibold transition-[transform,background-color,border-color,color,opacity] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-[#3d7a29]/55 focus-visible:ring-offset-2 focus-visible:ring-offset-[#f7fcf2] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";
  const width = full ? "w-full" : "";

  const variantCls =
    variant === "primary"
      ? "bg-[#15300c] text-[#f7fcf2] hover:-translate-y-0.5"
      : variant === "danger"
        ? "border-2 border-[#c0532f] text-[#c0532f] hover:bg-[#c0532f] hover:text-[#f7fcf2]"
        : "border-2 border-[#15300c] text-[#15300c] hover:bg-[#15300c] hover:text-[#f7fcf2]";

  const isDisabled = disabled || loading;
  const cls = `${base} ${variantCls} ${width}`;

  const content = (
    <>
      {loading && <Spinner size={16} />}
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
