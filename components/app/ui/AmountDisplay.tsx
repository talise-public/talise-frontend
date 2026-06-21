"use client";

import { useCurrency } from "../data/currency";

export type AmountDisplayProps = {
  /** The USD value (USDsui is 1:1 USD). Display-currency conversion is automatic. */
  usd: number;
  /** Headline font size in px. Default 34. */
  size?: number;
  /** Show the currency symbol. Default true. */
  showSymbol?: boolean;
  /** Add a "X.XX USDsui" sub-line under the headline. */
  subAsset?: boolean;
  /** Render in a muted tone. */
  muted?: boolean;
  className?: string;
};

/**
 * The canonical money display: large, negative-tracked, tabular-nums number in
 * the active display currency. The negative letter-spacing + tabular figures
 * are load-bearing for the brand look. `subAsset` adds the underlying USDsui
 * amount as a small mono sub-line.
 */
export function AmountDisplay({
  usd,
  size = 34,
  showSymbol = true,
  subAsset = false,
  muted = false,
  className = "",
}: AmountDisplayProps) {
  const { formatUsd, symbol } = useCurrency();

  const full = formatUsd(usd);
  // formatUsd prefixes the symbol; strip it when the caller doesn't want it.
  const text = showSymbol ? full : full.replace(symbol, "").trimStart();

  const usdsui = `${Math.abs(usd).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USDsui`;

  return (
    <span className={`inline-flex flex-col ${className}`}>
      <span
        className={`font-display font-semibold tabular-nums ${muted ? "text-[#3a5230]" : "text-[#15300c]"}`}
        style={{ fontSize: size, lineHeight: 1.04, letterSpacing: size >= 30 ? "-0.03em" : "-0.02em" }}
      >
        {text}
      </span>
      {subAsset && (
        <span className="mt-1 font-mono text-[11px] text-[#3d7a29] tabular-nums">{usdsui}</span>
      )}
    </span>
  );
}
