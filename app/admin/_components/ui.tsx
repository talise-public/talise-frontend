"use client";

import { useState, type ReactNode } from "react";

/**
 * Shared admin UI primitives. Dark Talise palette via Tailwind v4 theme
 * tokens (bg / surface / surface-2 / line / fg / fg-muted / fg-dim /
 * accent / accent-deep / danger). Mono = `font-mono`.
 *
 * Every section composes these so the dashboard reads as one product.
 */

// ─── Card + headers ────────────────────────────────────────────────

export function Card({
  children,
  className = "",
  pad = true,
}: {
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border border-line bg-surface ${pad ? "p-5" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-fg-dim">{subtitle}</p> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

// ─── Stat tiles ────────────────────────────────────────────────────

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "accent" | "danger" | "warn";
}) {
  const valueTone =
    tone === "accent"
      ? "text-accent"
      : tone === "danger"
        ? "text-danger"
        : tone === "warn"
          ? "text-amber-400"
          : "text-fg";
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="text-[11px] uppercase tracking-wide text-fg-dim">{label}</div>
      <div className={`mt-1.5 font-mono text-2xl font-semibold tabular-nums ${valueTone}`}>
        {value}
      </div>
      {hint ? <div className="mt-1 text-xs text-fg-dim">{hint}</div> : null}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{children}</div>
  );
}

// ─── Status badges ─────────────────────────────────────────────────

type BadgeTone = "success" | "pending" | "failed" | "neutral" | "info";

/** Map an arbitrary status string to a semantic tone. */
export function statusTone(status: string | null | undefined): BadgeTone {
  const s = (status ?? "").toLowerCase();
  if (!s) return "neutral";
  if (/(settled|success|succeeded|paid|complete|completed|approved|fulfilled|onchain_settled|confirmed|live|ok|done|active)/.test(s))
    return "success";
  if (/(fail|failed|rejected|error|refunded|cancel|cancelled|expired|reversed)/.test(s))
    return "failed";
  if (/(pending|open|quoted|debited|processing|settling|fiat_out_pending|in_progress|review|sent|queued|waiting|onchain_settling)/.test(s))
    return "pending";
  return "info";
}

export function StatusBadge({
  status,
  tone,
}: {
  status: string | null | undefined;
  tone?: BadgeTone;
}) {
  const t = tone ?? statusTone(status);
  const cls: Record<BadgeTone, string> = {
    success: "border-accent-deep/50 bg-accent-deep/15 text-accent",
    pending: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    failed: "border-danger/40 bg-danger/10 text-danger",
    info: "border-sky-500/40 bg-sky-500/10 text-sky-300",
    neutral: "border-line bg-surface-2 text-fg-dim",
  };
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[11px] ${cls[t]}`}
    >
      {status ?? "—"}
    </span>
  );
}

export function Pill({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-fg-muted ${className}`}
    >
      {children}
    </span>
  );
}

// ─── Mono / copy ───────────────────────────────────────────────────

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-xs text-fg-muted ${className}`}>{children}</span>;
}

/** Copyable monospace value (address, digest, id). Shows `display` but
 *  copies `value`. */
export function CopyText({
  value,
  display,
  className = "",
}: {
  value: string | null | undefined;
  display?: ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-fg-dim">—</span>;
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {}
        );
      }}
      title={`Copy ${value}`}
      className={`group inline-flex items-center gap-1 font-mono text-xs text-fg-muted hover:text-accent ${className}`}
    >
      <span>{display ?? value}</span>
      <span className="text-fg-dim group-hover:text-accent">{copied ? "✓" : "⧉"}</span>
    </button>
  );
}

// ─── Data table ────────────────────────────────────────────────────

export type Column<Row> = {
  key: string;
  header: ReactNode;
  /** Cell renderer. Receives the whole row. */
  cell: (row: Row) => ReactNode;
  /** Tailwind width/align classes for the <td>/<th>. */
  className?: string;
  align?: "left" | "right" | "center";
};

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty = "No rows.",
}: {
  columns: Array<Column<Row>>;
  rows: Row[];
  rowKey: (row: Row, i: number) => string | number;
  onRowClick?: (row: Row) => void;
  empty?: ReactNode;
}) {
  if (!rows.length) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line bg-surface-2/60">
            {columns.map((c) => (
              <th
                key={c.key}
                className={`px-3 py-2.5 text-[11px] font-medium uppercase tracking-wide text-fg-dim ${
                  c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left"
                } ${c.className ?? ""}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={rowKey(row, i)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`border-b border-line/60 last:border-0 ${
                onRowClick ? "cursor-pointer hover:bg-surface-2/50" : ""
              }`}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-3 py-2.5 align-middle text-fg-muted ${
                    c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left"
                  } ${c.className ?? ""}`}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Toolbar / search / filters ────────────────────────────────────

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-fg-dim focus:border-accent-deep focus:outline-none sm:w-72"
    />
  );
}

export function FilterTabs<V extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: V; label: string; count?: number }>;
  value: V;
  onChange: (v: V) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`rounded-lg border px-3 py-1.5 text-xs transition ${
              active
                ? "border-accent-deep bg-accent-deep/15 text-accent"
                : "border-line bg-surface-2 text-fg-muted hover:text-fg"
            }`}
          >
            {o.label}
            {typeof o.count === "number" ? (
              <span className="ml-1.5 font-mono text-[10px] text-fg-dim">{o.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function Pagination({
  page,
  pageCount,
  onPage,
  total,
}: {
  page: number;
  pageCount: number;
  onPage: (p: number) => void;
  total?: number;
}) {
  return (
    <div className="mt-3 flex items-center justify-between text-xs text-fg-dim">
      <span>
        Page {page + 1} of {Math.max(1, pageCount)}
        {typeof total === "number" ? ` · ${total.toLocaleString()} rows` : ""}
      </span>
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={page <= 0}
          onClick={() => onPage(page - 1)}
          className="rounded-md border border-line bg-surface-2 px-2.5 py-1 disabled:opacity-40 enabled:hover:text-fg"
        >
          Prev
        </button>
        <button
          type="button"
          disabled={page >= pageCount - 1}
          onClick={() => onPage(page + 1)}
          className="rounded-md border border-line bg-surface-2 px-2.5 py-1 disabled:opacity-40 enabled:hover:text-fg"
        >
          Next
        </button>
      </div>
    </div>
  );
}

// ─── States ────────────────────────────────────────────────────────

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-fg-dim">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-accent" />
      {label}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
      <span>{message}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-danger/40 px-2.5 py-1 text-xs hover:bg-danger/10"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-surface/40 px-4 py-10 text-center text-sm text-fg-dim">
      {children}
    </div>
  );
}

// ─── JSON / detail ─────────────────────────────────────────────────

export function JsonBlock({ json }: { json: string }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-[11px] leading-relaxed text-fg-muted">
      {json}
    </pre>
  );
}

/** Slide-over drawer for row detail. */
export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 flex h-full w-full max-w-lg flex-col border-l border-line bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="text-sm font-semibold text-fg">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line px-2 py-1 text-xs text-fg-dim hover:text-fg"
          >
            Close
          </button>
        </div>
        <div className="flex-1 overflow-auto p-5">{children}</div>
      </div>
    </div>
  );
}

/** Label/value row used inside drawers + detail cards. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line/50 py-2 text-sm last:border-0">
      <span className="shrink-0 text-fg-dim">{label}</span>
      <span className="min-w-0 break-words text-right text-fg-muted">{children}</span>
    </div>
  );
}
