/**
 * Shared admin formatters. All timestamps in the DB are BIGINT epoch
 * milliseconds (Date.now()). Money columns are mixed: some are USD
 * DOUBLE PRECISION, some are NUMERIC strings, some are micro-unit
 * strings — callers pick the right helper.
 */

/** Epoch-ms (number | string | bigint) → "May 31, 2026, 8:02 PM" (local). */
export function fmtMs(ms: number | string | bigint | null | undefined): string {
  if (ms == null || ms === "") return "—";
  const n = typeof ms === "bigint" ? Number(ms) : Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Date(n).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Epoch-ms → short date only, e.g. "May 31". */
export function fmtDay(ms: number | string | bigint | null | undefined): string {
  if (ms == null || ms === "") return "—";
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Date(n).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Epoch-ms → relative ("3m ago", "2d ago", "just now"). */
export function fmtRelative(ms: number | string | bigint | null | undefined, now = Date.now()): string {
  if (ms == null || ms === "") return "—";
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const diff = now - n;
  if (diff < 0) return "soon";
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** USD amount → "$1,234.56". Accepts number or numeric string. */
export function fmtUsd(v: number | string | null | undefined, dp = 2): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/** Plain number with thousands separators. */
export function fmtNum(v: number | string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

/** Amount in an arbitrary currency, e.g. fmtCcy(1500, "NGN"). */
export function fmtCcy(v: number | string | null | undefined, ccy: string, dp = 2): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return "—";
  return `${n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })} ${ccy}`;
}

/** Truncate a Sui address / digest: 0x1234…abcd. */
export function shortHash(s: string | null | undefined, head = 6, tail = 4): string {
  if (!s) return "—";
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** Boolean / 0|1 / "true" → "Yes" / "No". */
export function fmtBool(v: unknown): string {
  if (v === true || v === 1 || v === "1" || v === "true" || v === "t") return "Yes";
  if (v === false || v === 0 || v === "0" || v === "false" || v === "f") return "No";
  return "—";
}

/** KYC tier 0-3 → human label. */
export function tierLabel(t: number | string | null | undefined): string {
  const n = Number(t ?? 0);
  switch (n) {
    case 0: return "T0 · receive-only";
    case 1: return "T1 · basic";
    case 2: return "T2 · verified";
    case 3: return "T3 · full";
    default: return `T${n}`;
  }
}

/** Pretty-print a JSON-ish string/object, falling back to the raw value. */
export function prettyJson(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
