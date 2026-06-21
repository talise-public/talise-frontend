import { CC, type Currency } from "@/lib/fx";

export type FlagProps = {
  /** Either an ISO-3166 alpha-2 country code ("ng") or a Currency ("NGN"). */
  code: string;
  /** Rendered diameter in px. Default 24. */
  size?: number;
  className?: string;
};

/**
 * Circular country flag, rendered from the vendored circle-flags SVG set at
 * `/public/flags/<cc>.svg`. Accepts a 2-letter country code or a Currency
 * (mapped via CC). Replaces the emoji `FLAG` glyphs so flags render crisply
 * and consistently across platforms.
 */
export function Flag({ code, size = 24, className = "" }: FlagProps) {
  const cc =
    code.length === 2 ? code.toLowerCase() : (CC[code as Currency] ?? "");
  if (!cc) return null;
  return (
    <img
      src={`/flags/${cc}.svg`}
      alt=""
      aria-hidden
      width={size}
      height={size}
      className={`inline-block shrink-0 rounded-full object-cover ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
