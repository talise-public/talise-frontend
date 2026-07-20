/**
 * Activity classification + display helpers.
 *
 * The Foundation `useActivity()` hook types its rows narrowly
 * (`direction: "sent" | "received"`, `otherCoin: string | null`), but the live
 * `/api/activity` endpoint actually emits six directions
 * (sent | received | invest | withdraw | swap | autoswap) and a richer
 * `otherCoin` object (`{ coinType, symbol, amount, decimals }`). We widen the
 * row to its real runtime shape here, without touching the Foundation hook -
 * so the UI can render every category the server produces. The fields the
 * narrow type omits are read defensively (they may be absent on older rows).
 */

import type { ActivityEntry } from "@/components/app";

/** The full direction set the server can emit. */
export type ActivityDirection =
  | "sent"
  | "received"
  | "invest"
  | "withdraw"
  | "swap"
  | "autoswap";

/** Non-USDsui / non-SUI coin movement carried on a row (WAL, USDC, …). */
export type OtherCoin = {
  coinType?: string;
  symbol: string;
  /** Raw u64 as a string so big numbers survive without precision loss. */
  amount: string;
  decimals: number;
};

/**
 * The row as it really arrives over the wire. We intersect the Foundation
 * type with the wider runtime fields so existing `digest` / `timestampMs` /
 * `amountUsdsui` / etc. stay strongly typed while the extra shapes are
 * available.
 */
export type ActivityRow = Omit<ActivityEntry, "direction" | "otherCoin"> & {
  direction: ActivityDirection;
  otherCoin: OtherCoin | string | null;
};

/** Coerce a Foundation `ActivityEntry` to the wider runtime `ActivityRow`. */
export function asRow(e: ActivityEntry): ActivityRow {
  return e as unknown as ActivityRow;
}

/** The five filter chips shown on the Activity screen. */
export type FilterKey = "all" | "sent" | "received" | "earn" | "swap";

export const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "sent", label: "Sent" },
  { key: "received", label: "Received" },
  { key: "earn", label: "Earn" },
  { key: "swap", label: "Swap" },
];

/** Visual category, collapses the six server directions into five looks. */
export type Category =
  | "sent"
  | "received"
  | "invest"
  | "withdraw"
  | "swap"
  | "neutral";

export function categoryOf(row: ActivityRow): Category {
  switch (row.direction) {
    case "received":
      return "received";
    case "invest":
      return "invest";
    case "withdraw":
      return "withdraw";
    case "swap":
    case "autoswap":
      return "swap";
    case "sent":
      return "sent";
    default:
      return "neutral";
  }
}

/** Does `row` belong under the given filter chip? */
export function matchesFilter(row: ActivityRow, filter: FilterKey): boolean {
  switch (filter) {
    case "all":
      return true;
    case "sent":
      return row.direction === "sent";
    case "received":
      return row.direction === "received";
    case "earn":
      return row.direction === "invest" || row.direction === "withdraw";
    case "swap":
      return row.direction === "swap" || row.direction === "autoswap";
  }
}

/** Inflow (read as a credit, "+") vs outflow (debit, "-"). */
export function isInflow(row: ActivityRow): boolean {
  return row.direction === "received" || row.direction === "withdraw";
}

/** Read `otherCoin` whether it arrives as the rich object or a bare symbol. */
export function otherCoinOf(row: ActivityRow): OtherCoin | null {
  const oc = row.otherCoin;
  if (!oc) return null;
  if (typeof oc === "string") {
    return { symbol: oc, amount: "0", decimals: 9 };
  }
  return oc;
}

/** Format an `otherCoin` raw u64 into a human amount string (no symbol). */
export function formatCoinAmount(coin: OtherCoin): string {
  const raw = Number(coin.amount);
  if (!Number.isFinite(raw)) return "0";
  const value = raw / Math.pow(10, coin.decimals);
  // Trim to at most 4 dp, drop trailing zeros.
  const fixed = value.toFixed(4);
  return fixed.replace(/\.?0+$/, "");
}

const VENUE_NAMES: Record<string, string> = {
  navi: "NAVI",
  deepbook: "DeepBook",
};

export function displayVenue(venue: string | null | undefined): string {
  if (!venue) return "-";
  return VENUE_NAMES[venue.toLowerCase()] ?? venue.toUpperCase();
}

/** Row title, "Sent" / "Received" / "Invested in NAVI" / coin / swap. */
export function titleOf(row: ActivityRow): string {
  const coin = otherCoinOf(row);
  if (coin && coin.symbol.toUpperCase() !== "USDSUI") {
    return isInflow(row) ? `Received ${coin.symbol}` : `Sent ${coin.symbol}`;
  }
  switch (categoryOf(row)) {
    case "sent":
      return "Sent";
    case "received":
      return "Received";
    case "invest":
      return row.venue ? `Invested in ${displayVenue(row.venue)}` : "Invested";
    case "withdraw":
      return row.venue
        ? `Withdrew from ${displayVenue(row.venue)}`
        : "Withdrew";
    case "swap":
      if (row.direction === "swap") return "Swapped";
      return row.venue
        ? `Auto-swapped ${displayVenue(row.venue)}`
        : "Auto-swapped to USDsui";
    default:
      return "Activity";
  }
}

/** Counterparty label for the subtitle ("name@talise" or a short address). */
export function counterpartyLabel(row: ActivityRow): string | null {
  if (row.counterpartyName && row.counterpartyName.length > 0) {
    return row.counterpartyName;
  }
  if (row.counterparty) return shortAddress(row.counterparty);
  return null;
}

export function shortAddress(a: string, head = 6, tail = 4): string {
  if (a.length <= head + tail + 1) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

export function shortDigest(d: string): string {
  if (d.length <= 16) return d;
  return `${d.slice(0, 10)}…${d.slice(-6)}`;
}

/** Relative time, e.g. "3m ago", "2h ago", "5d ago", "now". */
export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (!Number.isFinite(diff)) return "";
  const abs = Math.abs(diff);
  const sec = Math.round(abs / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.round(day / 365);
  return `${yr}y ago`;
}

/** Absolute date+time for the receipt, e.g. "Jun 2, 2026, 4:31 PM". */
export function absoluteTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toString();
  }
}

export function suiscanUrl(digest: string): string {
  return `https://suiscan.xyz/mainnet/tx/${digest}`;
}

/* ── Cash-out (Linq off-ramp) ──────────────────────────────────────────── */

/** The off-ramp payload attached to a USDsui→NGN bank cash-out row. */
export type Offramp = NonNullable<ActivityEntry["offramp"]>;

/** Read the off-ramp payload off a row, if present (and non-null). */
export function offrampOf(row: ActivityRow): Offramp | null {
  return row.offramp ?? null;
}

export type OfframpState = "done" | "failed" | "pending";

/**
 * Collapse Linq's free-text status into one of three states.
 *   disbursed / settled / completed → done
 *   timeout* / failed               → failed
 *   everything else                 → pending (initiated, processing*, …)
 */
export function offrampState(status: string | null | undefined): OfframpState {
  const s = (status ?? "").toLowerCase();
  if (
    s.includes("disbursed") ||
    s.includes("settled") ||
    s.includes("complete")
  ) {
    return "done";
  }
  if (s.includes("timeout") || s.includes("fail")) return "failed";
  return "pending";
}

/** Short status chip label for a cash-out row. */
export function offrampChipLabel(status: string | null | undefined): string {
  switch (offrampState(status)) {
    case "done":
      return "Paid out";
    case "failed":
      return "Failed";
    default:
      return "Pending";
  }
}

/** Friendly, sentence-cased status for the receipt's Status row. */
export function offrampFriendlyStatus(
  status: string | null | undefined
): string {
  switch (offrampState(status)) {
    case "done":
      return "Paid out";
    case "failed":
      return "Failed";
    default:
      return "In progress";
  }
}

/** Format a naira amount as "₦12,345.67" (drops the kobo when whole). */
export function formatNgn(amount: number): string {
  if (!Number.isFinite(amount)) return "₦0";
  const whole = Math.round(amount) === amount;
  return `₦${amount.toLocaleString("en-NG", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Bank subtitle, e.g. "GTBank ••••1234" / "GTBank" / "Bank account". */
export function offrampBankLine(o: Offramp): string {
  const bank = o.bankName?.trim() || "Bank account";
  return o.accountLast4 ? `${bank} ••••${o.accountLast4}` : bank;
}
