"use client";

import { useMemo, useState } from "react";
import { useAdminData } from "../../_lib/fetcher";
import { fmtMs, fmtUsd, fmtCcy, shortHash, prettyJson } from "../../_lib/format";
import {
  SectionHeader,
  StatusBadge,
  Pill,
  CopyText,
  DataTable,
  type Column,
  SearchInput,
  FilterTabs,
  Pagination,
  Spinner,
  ErrorBanner,
  JsonBlock,
  Drawer,
  Field,
} from "../../_components/ui";

/**
 * /admin/transactions — the headline section. Successful / pending /
 * failed across the three transaction sources (on-chain history,
 * cross-border transfers, Linq off-ramp payouts). One DataTable whose
 * columns adapt to the active source; row click opens a full-detail
 * Drawer. All read-only, served by /api/admin/transactions.
 */

type Source = "onchain" | "transfers" | "linq";
type StatusFilter = "all" | "success" | "pending" | "failed";

type Row = Record<string, unknown> & { bucket?: "success" | "pending" | "failed" };

type ApiResponse = {
  source: Source;
  rows: Row[];
  total: number;
  page: number;
  pageSize: number;
  counts: { all: number; success: number; pending: number; failed: number };
};

const SOURCE_OPTIONS: Array<{ value: Source; label: string }> = [
  { value: "onchain", label: "On-chain" },
  { value: "transfers", label: "Cross-border transfers" },
  { value: "linq", label: "Linq payouts" },
];

// ─── helpers ───────────────────────────────────────────────────────

function s(v: unknown): string | null {
  if (v == null) return null;
  return String(v);
}
function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true" || v === "t";
}

function digestCell(v: unknown) {
  const d = s(v);
  return d ? <CopyText value={d} display={shortHash(d)} /> : <span className="text-fg-dim">—</span>;
}
function textCell(v: unknown) {
  const t = s(v);
  return t ? t : <span className="text-fg-dim">—</span>;
}

// ─── column sets (one per source) ──────────────────────────────────

const onchainColumns: Array<Column<Row>> = [
  { key: "created_at", header: "Time", cell: (r) => <span className="whitespace-nowrap">{fmtMs(s(r.created_at))}</span> },
  { key: "user_email", header: "User", cell: (r) => textCell(r.user_email ?? r.user_id) },
  { key: "kind", header: "Kind", cell: (r) => <Pill>{s(r.kind) ?? "—"}</Pill> },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    cell: (r) => (
      <span className="font-mono text-fg">
        {s(r.amount) ?? "—"} {s(r.asset) ?? ""}
      </span>
    ),
  },
  { key: "recipient", header: "Recipient", cell: (r) => digestCell(r.recipient) },
  { key: "digest", header: "Digest", cell: (r) => digestCell(r.digest) },
  { key: "status", header: "Status", cell: () => <StatusBadge status="success" /> },
];

const transfersColumns: Array<Column<Row>> = [
  { key: "created_at", header: "Time", cell: (r) => <span className="whitespace-nowrap">{fmtMs(s(r.created_at))}</span> },
  { key: "user_id", header: "User", cell: (r) => textCell(r.user_id) },
  { key: "kind", header: "Kind", cell: (r) => <Pill>{s(r.kind) ?? "—"}</Pill> },
  { key: "provider", header: "Provider", cell: (r) => textCell(r.provider) },
  {
    key: "route",
    header: "Route",
    cell: (r) => (
      <span className="font-mono text-xs text-fg-muted">
        {s(r.source_currency) ?? "?"} → {s(r.dest_currency) ?? "?"}
      </span>
    ),
  },
  {
    key: "usdsui_amount",
    header: "USDsui",
    align: "right",
    cell: (r) => <span className="font-mono text-fg">{fmtUsd(s(r.usdsui_amount))}</span>,
  },
  {
    key: "dest_amount",
    header: "Dest",
    align: "right",
    cell: (r) => (
      <span className="font-mono text-fg-muted">
        {r.dest_amount != null ? fmtCcy(s(r.dest_amount), s(r.dest_currency) ?? "") : "—"}
      </span>
    ),
  },
  {
    key: "state",
    header: "State",
    cell: (r) => (
      <span className="inline-flex items-center gap-1.5">
        <StatusBadge status={s(r.state)} />
        {truthy(r.parked_funds) ? (
          <Pill className="border-danger/40 bg-danger/10 text-danger">parked</Pill>
        ) : null}
      </span>
    ),
  },
  { key: "onchain_digest", header: "Digest", cell: (r) => digestCell(r.onchain_digest) },
];

const linqColumns: Array<Column<Row>> = [
  { key: "created_at", header: "Time", cell: (r) => <span className="whitespace-nowrap">{fmtMs(s(r.created_at))}</span> },
  { key: "user_id", header: "User", cell: (r) => textCell(r.user_id) },
  {
    key: "amount_usdsui",
    header: "USDsui",
    align: "right",
    cell: (r) => <span className="font-mono text-fg">{fmtUsd(s(r.amount_usdsui))}</span>,
  },
  {
    key: "amount_ngn",
    header: "NGN",
    align: "right",
    cell: (r) => <span className="font-mono text-fg-muted">{fmtCcy(s(r.amount_ngn), "NGN")}</span>,
  },
  { key: "bank_account_name", header: "Beneficiary", cell: (r) => textCell(r.bank_account_name) },
  { key: "bank_account_number", header: "Account", cell: (r) => <CopyText value={s(r.bank_account_number)} /> },
  { key: "linq_order_id", header: "Order", cell: (r) => <CopyText value={s(r.linq_order_id)} display={shortHash(s(r.linq_order_id), 8, 4)} /> },
  { key: "status", header: "Status", cell: (r) => <StatusBadge status={s(r.status)} /> },
];

function columnsFor(source: Source): Array<Column<Row>> {
  if (source === "transfers") return transfersColumns;
  if (source === "linq") return linqColumns;
  return onchainColumns;
}

// ─── page ──────────────────────────────────────────────────────────

export default function TransactionsPage() {
  const [source, setSource] = useState<Source>("onchain");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [page, setPage] = useState(0);
  const [q, setQ] = useState("");

  const path = useMemo(() => {
    const p = new URLSearchParams({ source, status, page: String(page) });
    if (q.trim()) p.set("q", q.trim());
    return `/api/admin/transactions?${p.toString()}`;
  }, [source, status, page, q]);

  const { data, error, loading, refetch } = useAdminData<ApiResponse>(path);

  function changeSource(next: Source) {
    if (next === source) return;
    setSource(next);
    setStatus("all"); // changing source resets status + page
    setPage(0);
    setQ("");
  }

  const counts = data?.counts ?? { all: 0, success: 0, pending: 0, failed: 0 };
  const statusOptions: Array<{ value: StatusFilter; label: string; count?: number }> = [
    { value: "all", label: "All", count: counts.all },
    { value: "success", label: "Successful", count: counts.success },
    { value: "pending", label: "Pending", count: counts.pending },
    { value: "failed", label: "Failed", count: counts.failed },
  ];

  const columns = columnsFor(source);
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 50;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const [selected, setSelected] = useState<Row | null>(null);

  const searchPlaceholder =
    source === "onchain"
      ? "Search digest / recipient / user…"
      : source === "transfers"
        ? "Search digest / reference / user…"
        : "Search reference / account / user…";

  const emptyMsg =
    status === "all"
      ? "No transactions for this source."
      : `No ${status} transactions for this source.`;

  return (
    <div>
      <SectionHeader
        title="Transactions"
        subtitle="Successful, pending and failed across on-chain history, cross-border transfers and Linq payouts."
        right={
          <button
            type="button"
            onClick={refetch}
            className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
          >
            Refresh
          </button>
        }
      />

      {/* Source switcher */}
      <div className="mb-3">
        <FilterTabs<Source> options={SOURCE_OPTIONS} value={source} onChange={changeSource} />
      </div>

      {/* Status filter + search */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FilterTabs<StatusFilter>
          options={statusOptions}
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(0);
          }}
        />
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(0);
          }}
          placeholder={searchPlaceholder}
        />
      </div>

      {error ? <ErrorBanner message={error} onRetry={refetch} /> : null}
      {loading && !data ? <Spinner /> : null}

      {data ? (
        <>
          <DataTable<Row>
            columns={columns}
            rows={rows}
            rowKey={(r, i) => String(r.id ?? i)}
            onRowClick={(r) => setSelected(r)}
            empty={emptyMsg}
          />
          <Pagination page={page} pageCount={pageCount} onPage={setPage} total={total} />
        </>
      ) : null}

      <TxDrawer source={source} row={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

// ─── detail drawer ─────────────────────────────────────────────────

function TxDrawer({
  source,
  row,
  onClose,
}: {
  source: Source;
  row: Row | null;
  onClose: () => void;
}) {
  if (!row) return <Drawer open={false} onClose={onClose} title="" children={null} />;

  const title =
    source === "onchain"
      ? "On-chain transaction"
      : source === "transfers"
        ? "Cross-border transfer"
        : "Linq payout";

  return (
    <Drawer open={!!row} onClose={onClose} title={title}>
      <div className="space-y-4">
        {source === "onchain" ? <OnchainDetail row={row} /> : null}
        {source === "transfers" ? <TransfersDetail row={row} /> : null}
        {source === "linq" ? <LinqDetail row={row} /> : null}
      </div>
    </Drawer>
  );
}

function detailVal(v: unknown) {
  const t = s(v);
  return t == null || t === "" ? <span className="text-fg-dim">—</span> : t;
}

function OnchainDetail({ row }: { row: Row }) {
  return (
    <>
      <Field label="ID">{detailVal(row.id)}</Field>
      <Field label="Time">{fmtMs(s(row.created_at))}</Field>
      <Field label="User">{detailVal(row.user_email ?? row.user_id)}</Field>
      <Field label="User ID">{detailVal(row.user_id)}</Field>
      <Field label="Kind">{detailVal(row.kind)}</Field>
      <Field label="Amount">
        {(s(row.amount) ?? "—") + " " + (s(row.asset) ?? "")}
      </Field>
      <Field label="Recipient">
        <CopyText value={s(row.recipient)} display={shortHash(s(row.recipient))} />
      </Field>
      <Field label="Digest">
        <CopyText value={s(row.digest)} display={shortHash(s(row.digest))} />
      </Field>
      <Field label="Receipt object">
        <CopyText value={s(row.receipt_object_id)} display={shortHash(s(row.receipt_object_id))} />
      </Field>
      <Field label="Memo">{detailVal(row.memo)}</Field>
      <Field label="Status">
        <StatusBadge status="success" />
      </Field>
    </>
  );
}

function TransfersDetail({ row }: { row: Row }) {
  return (
    <>
      <Field label="ID">
        <CopyText value={s(row.id)} display={shortHash(s(row.id), 8, 6)} />
      </Field>
      <Field label="Created">{fmtMs(s(row.created_at))}</Field>
      <Field label="Updated">{fmtMs(s(row.updated_at))}</Field>
      <Field label="User ID">{detailVal(row.user_id)}</Field>
      <Field label="Kind">{detailVal(row.kind)}</Field>
      <Field label="Provider">{detailVal(row.provider)}</Field>
      <Field label="Route">
        {(s(row.source_currency) ?? "?") + " → " + (s(row.dest_currency) ?? "?")}
      </Field>
      <Field label="Source amount">
        {row.source_amount != null ? fmtCcy(s(row.source_amount), s(row.source_currency) ?? "") : "—"}
      </Field>
      <Field label="USDsui">{fmtUsd(s(row.usdsui_amount))}</Field>
      <Field label="Dest amount">
        {row.dest_amount != null ? fmtCcy(s(row.dest_amount), s(row.dest_currency) ?? "") : "—"}
      </Field>
      <Field label="FX rate">{detailVal(row.fx_rate)}</Field>
      <Field label="State">
        <span className="inline-flex items-center gap-1.5">
          <StatusBadge status={s(row.state)} />
          {truthy(row.parked_funds) ? (
            <Pill className="border-danger/40 bg-danger/10 text-danger">parked</Pill>
          ) : null}
        </span>
      </Field>
      <Field label="State reason">{detailVal(row.state_reason)}</Field>
      <Field label="On-chain digest">
        <CopyText value={s(row.onchain_digest)} display={shortHash(s(row.onchain_digest))} />
      </Field>
      <Field label="Provider ref">
        <CopyText value={s(row.provider_reference)} display={shortHash(s(row.provider_reference), 8, 4)} />
      </Field>
      <Field label="Debited">{fmtMs(s(row.debited_at))}</Field>
      <Field label="On-chain settled">{fmtMs(s(row.onchain_settled_at))}</Field>
      <Field label="Settled">{fmtMs(s(row.settled_at))}</Field>
      <Field label="Failed">{fmtMs(s(row.failed_at))}</Field>
      <div>
        <div className="mb-1.5 text-sm text-fg-dim">Metadata</div>
        <JsonBlock json={prettyJson(row.metadata)} />
      </div>
    </>
  );
}

function LinqDetail({ row }: { row: Row }) {
  return (
    <>
      <Field label="ID">
        <CopyText value={s(row.id)} display={shortHash(s(row.id), 8, 6)} />
      </Field>
      <Field label="Linq order">
        <CopyText value={s(row.linq_order_id)} display={shortHash(s(row.linq_order_id), 8, 4)} />
      </Field>
      <Field label="Created">{fmtMs(s(row.created_at))}</Field>
      <Field label="Updated">{fmtMs(s(row.updated_at))}</Field>
      <Field label="User ID">{detailVal(row.user_id)}</Field>
      <Field label="USDsui">{fmtUsd(s(row.amount_usdsui))}</Field>
      <Field label="NGN amount">{fmtCcy(s(row.amount_ngn), "NGN")}</Field>
      <Field label="Rate">{detailVal(row.rate)}</Field>
      <Field label="Bank code">{detailVal(row.bank_code)}</Field>
      <Field label="Account number">
        <CopyText value={s(row.bank_account_number)} />
      </Field>
      <Field label="Account name">{detailVal(row.bank_account_name)}</Field>
      <Field label="Deposit wallet">
        <CopyText value={s(row.wallet_address)} display={shortHash(s(row.wallet_address))} />
      </Field>
      <Field label="Status">
        <StatusBadge status={s(row.status)} />
      </Field>
      <Field label="Status reason">{detailVal(row.status_reason)}</Field>
    </>
  );
}
