export type SpinnerProps = { size?: number };

/** Minimal spinner — a forest arc on a faint ring. */
export function Spinner({ size = 18 }: SpinnerProps) {
  const stroke = Math.max(2, Math.round(size / 9));
  return (
    <span
      role="status"
      aria-label="Loading"
      className="inline-block animate-spin rounded-full align-[-0.125em]"
      style={{
        width: size,
        height: size,
        borderWidth: stroke,
        borderStyle: "solid",
        borderColor: "color-mix(in srgb, #3d7a29 22%, transparent)",
        borderTopColor: "#3d7a29",
      }}
    />
  );
}
