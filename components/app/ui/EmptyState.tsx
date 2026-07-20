import type { ReactNode } from "react";

export type EmptyStateProps = {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  action?: ReactNode;
};

/** Centered placeholder for empty lists/screens. */
export function EmptyState({ icon, title, subtitle, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && (
        <span
          className="mb-4 flex size-14 items-center justify-center rounded-full text-[#15300c]"
          style={{ background: "#CAFFB8" }}
        >
          {icon}
        </span>
      )}
      <h3 className="text-[17px] font-semibold text-[#15300c]" style={{ letterSpacing: "-0.05em" }}>
        {title}
      </h3>
      {subtitle && <p className="mt-1.5 max-w-xs text-[14px] text-[#3d7a29]">{subtitle}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
