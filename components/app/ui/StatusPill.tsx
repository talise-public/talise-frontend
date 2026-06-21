import type { ReactNode } from "react";

export type StatusTone =
  | "funded"
  | "claimed"
  | "active"
  | "paused"
  | "completed"
  | "pending"
  | "neutral"
  | "success"
  | "danger";

export type StatusPillProps = { label: string; tone?: StatusTone };

// Each tone → {fg text colour, faint matching background tint}. Tuned for the
// light-mint canvas: forest text on a soft-mint fill for positive states, a
// warm ochre for pending/paused, fg-muted on surface-2 for neutral/completed,
// and a deep terracotta on a soft-red wash for danger (all AA on light).
const TONES: Record<StatusTone, { color: string; bg: string }> = {
  funded: { color: "#3d7a29", bg: "#CAFFB8" },
  active: { color: "#3d7a29", bg: "#CAFFB8" },
  success: { color: "#3d7a29", bg: "#CAFFB8" },
  claimed: { color: "#3d7a29", bg: "#CAFFB8" },
  completed: { color: "#3a5230", bg: "rgba(21,48,12,0.06)" },
  paused: { color: "#8a6a16", bg: "#FFE59E" },
  pending: { color: "#8a6a16", bg: "#FFE59E" },
  danger: { color: "#c0532f", bg: "rgba(255,158,122,0.32)" },
  neutral: { color: "#3d7a29", bg: "rgba(21,48,12,0.06)" },
};

/** Small capsule status badge, mono uppercase label, tone-tinted. */
export function StatusPill({ label, tone = "neutral" }: StatusPillProps) {
  const t = TONES[tone];
  const dot: ReactNode =
    tone === "active" || tone === "funded" || tone === "pending" || tone === "paused" ? (
      <span
        className="inline-block size-1.5 rounded-full"
        style={{ background: t.color }}
        aria-hidden
      />
    ) : null;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] font-medium uppercase"
      style={{ color: t.color, background: t.bg, letterSpacing: "0.1em" }}
    >
      {dot}
      {label}
    </span>
  );
}
