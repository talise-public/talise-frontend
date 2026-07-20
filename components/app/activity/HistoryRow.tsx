"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { BankIcon } from "@hugeicons/core-free-icons";
import { useCurrency, useHiddenAmounts, MASK_AMOUNT } from "@/components/app";
import { DirectionBadge } from "./DirectionBadge";
import {
  type ActivityRow,
  type Category,
  categoryOf,
  titleOf,
  counterpartyLabel,
  relativeTime,
  isInflow,
  otherCoinOf,
  formatCoinAmount,
  offrampOf,
  offrampState,
  offrampChipLabel,
  offrampBankLine,
  formatNgn,
} from "./types";

/**
 * One activity row. Borderless at rest; on hover it picks up a faint
 * directional fill (warm red = sent, forest = received/invest/swap) via the
 * `.talise-history-row` rule in globals.css.
 *
 * Wise-style layout: circular direction chip (size-9, accent-soft disc) left,
 * title + grey sublabel middle, big tabular amount right.
 */
export function HistoryRow({
  row,
  onOpen,
}: {
  row: ActivityRow;
  onOpen: () => void;
}) {
  const { formatLocal } = useCurrency();
  const { hidden } = useHiddenAmounts();
  const category = categoryOf(row);
  const time = relativeTime(row.timestampMs);
  const offramp = offrampOf(row);

  if (offramp) {
    const chip =
      offrampState(offramp.status) === "done"
        ? null
        : offrampChipLabel(offramp.status);
    const bank = offramp.bankName?.trim();
    return (
      <button
        type="button"
        onClick={onOpen}
        data-direction="sent"
        className="talise-history-row group relative flex w-full items-center gap-3 px-3 py-3 text-left transition-[transform,background-color,border-color] duration-150 ease-out active:scale-[0.995]"
      >
        {/* Bank/withdraw chip, coral disc (money out) */}
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-full"
          style={{ background: "#FF9E7A" }}
        >
          <HugeiconsIcon icon={BankIcon} size={17} color="#c0532f" strokeWidth={2} />
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className="truncate text-[14px] font-medium text-[#15300c]"
            style={{ letterSpacing: "-0.05em" }}
          >
            {bank ? `Cash out → ${bank}` : "Cash out"}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-[12px] text-[#3d7a29]">
            <span className="truncate">{offrampBankLine(offramp)}</span>
            <span className="opacity-40">·</span>
            <span className="shrink-0">{time}</span>
          </span>
        </span>

        <span className="flex shrink-0 flex-col items-end gap-1 pl-2">
          <span
            className="whitespace-nowrap text-[15px] font-semibold tabular-nums"
            style={{ color: "#c0532f", letterSpacing: "-0.05em" }}
          >
            −{hidden ? MASK_AMOUNT : formatNgn(offramp.amountNgn)}
          </span>
          {chip && (
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-medium"
              style={
                offrampState(offramp.status) === "failed"
                  ? {
                      color: "#c0532f",
                      background: "color-mix(in srgb, #c0532f 12%, transparent)",
                    }
                  : { color: "#3a5230", background: "rgba(21,48,12,0.06)" }
              }
            >
              {chip}
            </span>
          )}
        </span>
      </button>
    );
  }

  const sub = counterpartyLabel(row);

  return (
    <button
      type="button"
      onClick={onOpen}
      data-direction={directionAttr(category)}
      className="talise-history-row group relative flex w-full items-center gap-3 px-3 py-3 text-left transition-[transform,background-color,border-color] duration-150 ease-out active:scale-[0.995]"
    >
      {/* Direction chip, circular, size-9 (36px) */}
      <DirectionBadge category={category} />

      {/* Title + sublabel */}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className="truncate text-[14px] font-medium text-[#15300c]"
          style={{ letterSpacing: "-0.05em" }}
        >
          {titleOf(row)}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-[12px] text-[#3d7a29]">
          {sub && <span className="truncate">{sub}</span>}
          {sub && <span className="opacity-40">·</span>}
          <span className="shrink-0">{time}</span>
        </span>
      </span>

      {/* Amount, tabular, semibold for inflow (forest), medium for outflow (ink) */}
      <span className="relative shrink-0 pl-2">
        <Amount row={row} formatLocal={formatLocal} hidden={hidden} />
      </span>
    </button>
  );
}

/**
 * Map category onto the `data-direction` attribute consumed by the
 * `.landing-mint .talise-history-row` hover rules in globals.css.
 */
function directionAttr(
  category: Category
): "sent" | "received" | "invest" | "withdraw" | undefined {
  switch (category) {
    case "sent":
      return "sent";
    case "received":
      return "received";
    case "withdraw":
      return "withdraw";
    case "invest":
    case "swap":
      return "invest";
    default:
      return undefined;
  }
}

/** Trailing amount. Swaps render "X → Y"; everything else a signed credit. */
function Amount({
  row,
  formatLocal,
  hidden,
}: {
  row: ActivityRow;
  formatLocal: (usd: number, o?: { fixed?: boolean }) => string;
  hidden: boolean;
}) {
  const category = categoryOf(row);
  const coin = otherCoinOf(row);

  if (hidden) {
    if (category === "swap") {
      return (
        <span className="whitespace-nowrap text-[13px] tabular-nums text-[#3a5230]">
          {MASK_AMOUNT}
        </span>
      );
    }
    const inflow = isInflow(row);
    return (
      <span
        className={`whitespace-nowrap text-[15px] font-semibold tabular-nums ${inflow ? "text-[#3d7a29]" : "text-[#15300c]"}`}
        style={{ letterSpacing: "-0.05em" }}
      >
        {inflow ? "+" : "−"}
        {MASK_AMOUNT}
      </span>
    );
  }

  if (category === "swap") {
    const legs: string[] = [];
    if (row.amountSui && row.amountSui > 0) {
      legs.push(`${row.amountSui.toFixed(4).replace(/\.?0+$/, "")} SUI`);
    }
    if (coin && coin.symbol.toUpperCase() !== "USDSUI") {
      legs.push(`${formatCoinAmount(coin)} ${coin.symbol}`);
    }
    if (row.amountUsdsui && row.amountUsdsui > 0) {
      legs.push(formatLocal(Math.abs(row.amountUsdsui), { fixed: true }));
    }
    const text =
      legs.length === 0
        ? "-"
        : legs.length === 1
          ? `→ ${legs[0]}`
          : `${legs[0]} → ${legs[1]}`;
    return (
      <span className="whitespace-nowrap text-[13px] tabular-nums text-[#3a5230]">
        {text}
      </span>
    );
  }

  const inflow = isInflow(row);
  const prefix = inflow ? "+" : "−";
  // Inflow = forest green (positive credit); outflow = ink (neutral debit)
  const color = inflow ? "text-[#3d7a29]" : "text-[#15300c]";
  const weight = "font-semibold";

  let text: string;
  if (coin && coin.symbol.toUpperCase() !== "USDSUI") {
    text = `${prefix}${formatCoinAmount(coin)} ${coin.symbol}`;
  } else if (row.amountUsdsui != null) {
    text = `${prefix}${formatLocal(Math.abs(row.amountUsdsui), { fixed: true })}`;
  } else if (row.amountSui != null) {
    text = `${prefix}${Math.abs(row.amountSui).toFixed(4).replace(/\.?0+$/, "")} SUI`;
  } else {
    text = `${prefix}-`;
  }

  return (
    <span
      className={`whitespace-nowrap text-[15px] tabular-nums ${weight} ${color}`}
      style={{ letterSpacing: "-0.05em" }}
    >
      {text}
    </span>
  );
}
