"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useAdminData } from "../../_lib/fetcher";
import { fmtMs, fmtBool, shortHash, prettyJson } from "../../_lib/format";
import {
  SectionHeader,
  Card,
  Mono,
  CopyText,
  DataTable,
  type Column,
  Pagination,
  Spinner,
  ErrorBanner,
  EmptyState,
  JsonBlock,
  Drawer,
} from "../../_components/ui";

type TablesResp = { tables: Array<{ table: string; rowCount: number | null }> };

type RawRow = Record<string, unknown>;
type TableResp = {
  table: string;
  columns: string[];
  rows: RawRow[];
  total: number;
  page: number;
  pageSize: number;
};

// ── cell-shape heuristics ───────────────────────────────────────────

function looksLikeJson(s: string): boolean {
  const t = s.trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}

function isTimeColumn(col: string): boolean {
  return /(_at|_ms)$/.test(col) || col === "deadline_ms";
}

function isHashLike(col: string, s: string): boolean {
  // long opaque tokens: digests, addresses, object ids, sui_address, refs.
  if (/(digest|address|object_id|_id|reference|sub|salt|token)$/.test(col) && s.length > 18) return true;
  if (/^0x[0-9a-fA-F]{16,}$/.test(s)) return true;
  return s.length > 40 && !s.includes(" ");
}

/** Render one arbitrary cell value robustly. */
function renderCell(
  col: string,
  value: unknown,
  onJson: (title: string, json: unknown) => void,
  rowLabel: string
): ReactNode {
  if (value === null || value === undefined || value === "") {
    return <span className="text-fg-dim">—</span>;
  }

  // booleans / 0|1
  if (typeof value === "boolean") return <Mono>{fmtBool(value)}</Mono>;

  // timestamps
  if (isTimeColumn(col) && (typeof value === "number" || typeof value === "string")) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return <Mono>{fmtMs(value as number | string)}</Mono>;
  }

  // objects → JSON drawer
  if (typeof value === "object") {
    return (
      <button
        type="button"
        onClick={() => onJson(`${rowLabel} · ${col}`, value)}
        className="font-mono text-xs text-accent hover:underline"
      >
        {"{…}"} view →
      </button>
    );
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return <Mono className="text-fg">{String(value)}</Mono>;
  }

  if (typeof value === "string") {
    if (looksLikeJson(value)) {
      return (
        <button
          type="button"
          onClick={() => onJson(`${rowLabel} · ${col}`, value)}
          className="font-mono text-xs text-accent hover:underline"
        >
          {value.length > 24 ? `${value.slice(0, 24)}…` : value} view →
        </button>
      );
    }
    if (isHashLike(col, value)) {
      return <CopyText value={value} display={shortHash(value)} />;
    }
    if (value.length > 60) {
      return <span title={value} className="text-fg-muted">{value.slice(0, 60)}…</span>;
    }
    return <span className="text-fg-muted">{value}</span>;
  }

  return <span className="text-fg-muted">{String(value)}</span>;
}

export default function RawDbPage() {
  const [table, setTable] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<{ title: string; json: unknown } | null>(null);

  const dir = useAdminData<TablesResp>("/api/admin/raw");
  const tableData = useAdminData<TableResp>(
    table ? `/api/admin/raw?table=${encodeURIComponent(table)}&page=${page}` : "/api/admin/raw?__skip=1"
  );

  function pickTable(t: string) {
    setTable(t);
    setPage(0);
  }

  const onJson = (title: string, json: unknown) => setDetail({ title, json });

  // `tableData` can briefly hold the directory response ({tables}) — when no
  // table is selected — or stale rows for a previously-selected table while a
  // new fetch is in flight. Only treat it as the CURRENT table's data once its
  // `table` field matches the selection; otherwise `.total`/`.columns`/`.rows`
  // are undefined and the viewer would crash.
  const td: TableResp | null =
    tableData.data && (tableData.data as Partial<TableResp>).table === table
      ? (tableData.data as TableResp)
      : null;
  const tableLoading = !!table && !td && !tableData.error;

  const columns: Array<Column<RawRow>> = useMemo(() => {
    const cols = td?.columns ?? [];
    return cols.map((col) => ({
      key: col,
      header: col,
      align: /^(points|amount|usd|ngn|usdc|usdsui|fx_rate|tier|count|pool)/.test(col) || /_usd$|_amount$|_pool$/.test(col) ? "right" : "left",
      cell: (row: RawRow) => {
        const rowLabel = String(row.id ?? row.email ?? row.digest ?? "row");
        return renderCell(col, row[col], onJson, rowLabel);
      },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [td?.columns]);

  const pageSize = td?.pageSize ?? 50;
  const pageCount = td ? Math.ceil((td.total || 0) / pageSize) : 1;

  return (
    <div>
      <SectionHeader
        title="Raw DB"
        subtitle="Read-only browser over every whitelisted table"
        right={
          <button
            type="button"
            onClick={() => {
              dir.refetch();
              if (table) tableData.refetch();
            }}
            className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
          >
            Refresh
          </button>
        }
      />

      {dir.error ? <ErrorBanner message={dir.error} onRetry={dir.refetch} /> : null}
      {dir.loading && !dir.data ? <Spinner label="Loading tables…" /> : null}

      {/* Table picker */}
      {dir.data ? (
        <div className="mb-5 flex flex-wrap gap-1.5">
          {dir.data.tables.map((t) => {
            const active = t.table === table;
            return (
              <button
                key={t.table}
                type="button"
                onClick={() => pickTable(t.table)}
                className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition ${
                  active
                    ? "border-accent-deep bg-accent-deep/15 text-accent"
                    : "border-line bg-surface-2 text-fg-muted hover:text-fg"
                }`}
              >
                <span className="font-mono">{t.table}</span>
                <span className="font-mono text-[10px] text-fg-dim">
                  {t.rowCount == null ? "—" : t.rowCount.toLocaleString()}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Table viewer */}
      {!table ? (
        <EmptyState>Pick a table above to browse its rows.</EmptyState>
      ) : (
        <Card pad={false} className="p-5">
          <div className="mb-3 flex items-center gap-2 text-sm">
            <Mono className="text-fg">{table}</Mono>
            {td ? (
              <span className="text-xs text-fg-dim">
                · {(td.total ?? 0).toLocaleString()} rows · {td.columns.length} columns
              </span>
            ) : null}
          </div>

          {tableData.error ? <ErrorBanner message={tableData.error} onRetry={tableData.refetch} /> : null}
          {tableLoading ? <Spinner /> : null}

          {td ? (
            <>
              <DataTable<RawRow>
                columns={columns}
                rows={td.rows}
                rowKey={(row, i) => String(row.id ?? row.email ?? i)}
                empty="No rows in this table."
              />
              <Pagination page={page} pageCount={pageCount} onPage={setPage} total={td.total} />
            </>
          ) : null}
        </Card>
      )}

      <Drawer open={!!detail} onClose={() => setDetail(null)} title={detail?.title ?? "Cell"}>
        {detail ? <JsonBlock json={prettyJson(detail.json)} /> : null}
      </Drawer>
    </div>
  );
}
