"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  LinkSquare02Icon,
  Copy01Icon,
  Tick02Icon,
  BankIcon,
} from "@hugeicons/core-free-icons";
import { Sheet, Eyebrow, GlassCard, useCurrency } from "@/components/app";
import { DirectionBadge } from "./DirectionBadge";
import {
  type ActivityRow,
  categoryOf,
  titleOf,
  isInflow,
  otherCoinOf,
  formatCoinAmount,
  counterpartyLabel,
  shortDigest,
  absoluteTime,
  displayVenue,
  suiscanUrl,
  offrampOf,
  offrampState,
  offrampFriendlyStatus,
  offrampBankLine,
  formatNgn,
} from "./types";

/**
 * On-chain receipt for a tapped activity row. Hero amount in the user's
 * display currency, USDsui sub-line, counterparty/venue, timestamp, network,
 * canonical digest (Suiscan link + copy), fee ("$0 — sponsored"), and the
 * round-up if the send carried one.
 *
 * Design: hero badge + eyebrow label, big amount, clean detail card (flat
 * white + hairline, list rows with thin dividers), then two action buttons
 * (primary forest + ghost secondary). All radii follow the design system —
 * rounded-xl for buttons and cards, rounded-full only for the badge and pills.
 */
export function ReceiptSheet({
  row,
  open,
  onClose,
}: {
  row: ActivityRow | null;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Receipt" size="md">
      {row && <ReceiptBody row={row} />}
    </Sheet>
  );
}

function ReceiptBody({ row }: { row: ActivityRow }) {
  const offramp = offrampOf(row);
  if (offramp) return <CashOutReceipt row={row} offramp={offramp} />;
  return <SendReceipt row={row} />;
}

/**
 * USDsui→NGN bank cash-out receipt. Bank hero badge, big NGN payout, then the
 * destination bank, the USDsui debited, the FX rate, status, date, and digest.
 */
function CashOutReceipt({
  row,
  offramp,
}: {
  row: ActivityRow;
  offramp: NonNullable<ActivityRow["offramp"]>;
}) {
  const { formatLocal } = useCurrency();
  const [copied, setCopied] = useState(false);
  const done = offrampState(offramp.status) === "done";
  const failed = offrampState(offramp.status) === "failed";

  const copyDigest = async () => {
    try {
      await navigator.clipboard.writeText(row.digest);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  const sentUsdsui =
    row.amountUsdsui != null
      ? `${Math.abs(row.amountUsdsui).toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} USDsui`
      : "—";

  return (
    <div className="flex flex-col items-center gap-5 pb-2 pt-1">
      {/* Hero badge — bank glyph on a coral disc (money out) */}
      <div className="flex flex-col items-center gap-2">
        <span
          className="flex items-center justify-center rounded-full"
          style={{
            width: 56,
            height: 56,
            background: "#FF9E7A",
          }}
        >
          <HugeiconsIcon icon={BankIcon} size={24} color="#c0532f" strokeWidth={2} />
        </span>
        <Eyebrow>Cash out</Eyebrow>
      </div>

      {/* Big NGN payout */}
      <div className="flex flex-col items-center gap-1 text-center">
        <span
          className="font-semibold text-[#15300c] tabular-nums"
          style={{ fontFamily: "var(--font-display-v2)", fontSize: 38, lineHeight: 1.06, letterSpacing: "-0.03em" }}
        >
          {done ? "You received " : ""}
          {formatNgn(offramp.amountNgn)}
        </span>
      </div>

      {/* Details card */}
      <GlassCard className="w-full">
        <DetailRow label="To" value={offrampBankLine(offramp)} />
        <Divider />
        <DetailRow label="You sent" value={sentUsdsui} />
        <Divider />
        <DetailRow
          label="Rate"
          value={`$1 = ${formatNgn(offramp.rate)}`}
        />
        <Divider />
        <DetailRow
          label="Status"
          value={offrampFriendlyStatus(offramp.status)}
          valueClass={
            failed ? "text-[#c0532f]" : done ? "text-[#3d7a29]" : "text-[#15300c]"
          }
        />
        <Divider />
        <DetailRow label="Date" value={absoluteTime(row.timestampMs)} />
        <Divider />
        <DetailRow label="Digest" value={shortDigest(row.digest)} mono />
      </GlassCard>

      {/* Actions */}
      <div className="flex w-full flex-col gap-2.5">
        <a
          href={suiscanUrl(row.digest)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[#15300c] text-[15px] font-semibold text-[#f7fcf2] transition-transform duration-150 hover:-translate-y-0.5 active:scale-[0.98]"
        >
          <HugeiconsIcon icon={LinkSquare02Icon} size={16} strokeWidth={2} />
          View on Suiscan
        </a>
        <button
          type="button"
          onClick={copyDigest}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-full border-2 border-[#15300c] text-[14px] font-medium text-[#15300c] transition-colors hover:bg-[#15300c] hover:text-[#f7fcf2]"
        >
          <HugeiconsIcon
            icon={copied ? Tick02Icon : Copy01Icon}
            size={16}
            strokeWidth={2}
          />
          {copied ? "Copied" : "Copy digest"}
        </button>
      </div>
    </div>
  );
}

function SendReceipt({ row }: { row: ActivityRow }) {
  const { formatLocal } = useCurrency();
  const [copied, setCopied] = useState(false);
  const category = categoryOf(row);
  const coin = otherCoinOf(row);
  const inflow = isInflow(row);
  const sign = inflow ? "+" : "−";

  const copyDigest = async () => {
    try {
      await navigator.clipboard.writeText(row.digest);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  // Counterparty / venue row depends on category.
  const cpLabel = counterpartyLabel(row);
  let partyRow: { label: string; value: string; mono: boolean } | null = null;
  if (category === "sent") {
    partyRow = {
      label: "To",
      value: cpLabel ?? "—",
      mono: !row.counterpartyName,
    };
  } else if (category === "received") {
    partyRow = {
      label: "From",
      value: cpLabel ?? "—",
      mono: !row.counterpartyName,
    };
  } else if (category === "invest" || category === "withdraw") {
    partyRow = { label: "Venue", value: displayVenue(row.venue), mono: false };
  } else if (category === "swap" && cpLabel) {
    partyRow = {
      label: "Counterparty",
      value: cpLabel,
      mono: !row.counterpartyName,
    };
  }

  // Hero amount string.
  let heroPrimary: string;
  if (coin && coin.symbol.toUpperCase() !== "USDSUI") {
    heroPrimary = `${sign}${formatCoinAmount(coin)} ${coin.symbol}`;
  } else if (row.amountUsdsui != null) {
    heroPrimary = `${sign}${formatLocal(Math.abs(row.amountUsdsui), { fixed: true })}`;
  } else if (row.amountSui != null) {
    heroPrimary = `${sign}${Math.abs(row.amountSui).toFixed(4).replace(/\.?0+$/, "")} SUI`;
  } else {
    heroPrimary = "—";
  }

  const hasUsd = row.amountUsdsui != null && !coin;
  const roundup =
    typeof row.roundupUsdsui === "number" && row.roundupUsdsui > 0
      ? row.roundupUsdsui
      : null;

  return (
    <div className="flex flex-col items-center gap-5 pb-2 pt-1">
      {/* Hero badge + transaction label */}
      <div className="flex flex-col items-center gap-2">
        <DirectionBadge category={category} size={56} iconSize={22} />
        <Eyebrow>{titleOf(row)}</Eyebrow>
      </div>

      {/* Big amount — sign-carrying headline in display currency, USDsui sub-line */}
      <div className="flex flex-col items-center gap-1 text-center">
        <span
          className="font-semibold text-[#15300c] tabular-nums"
          style={{ fontFamily: "var(--font-display-v2)", fontSize: 38, lineHeight: 1.06, letterSpacing: "-0.03em" }}
        >
          {heroPrimary}
        </span>
        {hasUsd && (
          <span className="font-mono text-[11px] tabular-nums text-[#3d7a29]">
            {sign}
            {Math.abs(row.amountUsdsui as number).toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}{" "}
            USDsui
          </span>
        )}
      </div>

      {/* Details card — flat cream surface, thin dividers between rows */}
      <GlassCard className="w-full">
        {partyRow && (
          <>
            <DetailRow
              label={partyRow.label}
              value={partyRow.value}
              mono={partyRow.mono}
            />
            <Divider />
          </>
        )}
        <DetailRow label="Date" value={absoluteTime(row.timestampMs)} />
        <Divider />
        <DetailRow label="Network" value="Sui Mainnet" />
        <Divider />
        <DetailRow label="Fee" value="$0 — sponsored" valueClass="text-[#3d7a29]" />
        {roundup != null && (
          <>
            <Divider />
            <DetailRow
              label="Rounded up"
              value={`+${formatLocal(roundup, { fixed: true })} saved`}
              valueClass="text-[#3d7a29]"
            />
          </>
        )}
        <Divider />
        <DetailRow label="Digest" value={shortDigest(row.digest)} mono />
      </GlassCard>

      {/* Actions — primary forest CTA + ghost secondary, both rounded-xl */}
      <div className="flex w-full flex-col gap-2.5">
        <a
          href={suiscanUrl(row.digest)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[#15300c] text-[15px] font-semibold text-[#f7fcf2] transition-transform duration-150 hover:-translate-y-0.5 active:scale-[0.98]"
        >
          <HugeiconsIcon icon={LinkSquare02Icon} size={16} strokeWidth={2} />
          View on Suiscan
        </a>
        <button
          type="button"
          onClick={copyDigest}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-full border-2 border-[#15300c] text-[14px] font-medium text-[#15300c] transition-colors hover:bg-[#15300c] hover:text-[#f7fcf2]"
        >
          <HugeiconsIcon
            icon={copied ? Tick02Icon : Copy01Icon}
            size={16}
            strokeWidth={2}
          />
          {copied ? "Copied" : "Copy digest"}
        </button>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
  valueClass = "text-[#15300c]",
}: {
  label: string;
  value: string;
  mono?: boolean;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="shrink-0 text-[13px] text-[#3a5230]">{label}</span>
      <span
        className={`min-w-0 truncate text-right ${mono ? "font-mono text-[12px]" : "text-[13px] font-medium"} ${valueClass}`}
      >
        {value}
      </span>
    </div>
  );
}

function Divider() {
  return <div className="mx-4 h-px bg-[#15300c]/10" />;
}
