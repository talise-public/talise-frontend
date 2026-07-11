"use client";

import { useMemo, useState } from "react";
import { useAdminData } from "../../_lib/fetcher";
import { fmtMs, fmtUsd, fmtNum, shortHash, fmtBool, prettyJson } from "../../_lib/format";
import {
  SectionHeader,
  StatusBadge,
  Mono,
  CopyText,
  DataTable,
  type Column,
  FilterTabs,
  Pagination,
  Spinner,
  ErrorBanner,
  JsonBlock,
  Drawer,
  Field,
} from "../../_components/ui";

type Tab = "rewards" | "goals" | "redemptions" | "invoices";

type RewardRow = {
  id: string | number;
  user_id: string | null;
  email: string | null;
  kind: string | null;
  points: number | string | null;
  metadata: unknown;
  created_at: number | string | null;
};

type GoalRow = {
  id: string | number;
  user_id: string | null;
  name: string | null;
  target_usd: number | string | null;
  current_usd: number | string | null;
  deadline_ms: number | string | null;
  color: string | null;
  archived: unknown;
  created_at: number | string | null;
};

type RedemptionRow = {
  id: string | number;
  user_id: string | null;
  sku: string | null;
  points_spent: number | string | null;
  status: string | null;
  metadata: unknown;
  created_at: number | string | null;
  fulfilled_at: number | string | null;
};

type InvoiceRow = {
  id: string | number;
  business_user_id: string | null;
  email: string | null;
  slug: string | null;
  amount_usdc: number | string | null;
  reference: string | null;
  customer_email: string | null;
  status: string | null;
  created_at: number | string | null;
  paid_at: number | string | null;
  paid_digest: string | null;
  paid_by_address: string | null;
};

type AnyRow = RewardRow | GoalRow | RedemptionRow | InvoiceRow;

type LedgerResp = {
  tab: Tab;
  rows: AnyRow[];
  total: number;
  page: number;
  pageSize: number;
};

const TAB_OPTIONS: Array<{ value: Tab; label: string }> = [
  { value: "rewards", label: "Rewards" },
  { value: "goals", label: "Savings goals" },
  { value: "redemptions", label: "Redemptions" },
  { value: "invoices", label: "Invoices" },
];

function points(v: number | string | null) {
  return <Mono className="text-fg">{fmtNum(v)}</Mono>;
}

export default function LedgerPage() {
  const [tab, setTab] = useState<Tab>("rewards");
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<{ title: string; json: unknown } | null>(null);

  const { data, error, loading, refetch } = useAdminData<LedgerResp>(
    `/api/admin/ledger?tab=${tab}&page=${page}`
  );

  const pageSize = data?.pageSize ?? 50;
  const pageCount = data ? Math.ceil((data.total || 0) / pageSize) : 1;

  function switchTab(next: Tab) {
    setTab(next);
    setPage(0);
  }

  const rewardsCols: Array<Column<RewardRow>> = useMemo(
    () => [
      { key: "created_at", header: "When", cell: (r) => <Mono>{fmtMs(r.created_at)}</Mono> },
      { key: "kind", header: "Kind", cell: (r) => <StatusBadge status={r.kind} /> },
      {
        key: "email",
        header: "User",
        cell: (r) => r.email ?? <CopyText value={r.user_id ? String(r.user_id) : null} display={shortHash(r.user_id ? String(r.user_id) : null)} />,
      },
      { key: "points", header: "Points", align: "right", cell: (r) => points(r.points) },
      {
        key: "metadata",
        header: "Meta",
        cell: (r) => (r.metadata != null && r.metadata !== "" ? <Mono className="text-accent">view →</Mono> : <span className="text-fg-dim">—</span>),
      },
    ],
    []
  );

  const goalsCols: Array<Column<GoalRow>> = useMemo(
    () => [
      { key: "created_at", header: "Created", cell: (r) => <Mono>{fmtMs(r.created_at)}</Mono> },
      {
        key: "name",
        header: "Goal",
        cell: (r) => (
          <span className="inline-flex items-center gap-2 text-fg">
            {r.color ? (
              <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-line" style={{ backgroundColor: r.color }} />
            ) : null}
            {r.name ?? "—"}
          </span>
        ),
      },
      {
        key: "progress",
        header: "Progress",
        cell: (r) => <GoalProgress current={r.current_usd} target={r.target_usd} />,
      },
      { key: "deadline_ms", header: "Deadline", cell: (r) => <Mono>{fmtMs(r.deadline_ms)}</Mono> },
      {
        key: "archived",
        header: "State",
        cell: (r) => <StatusBadge status={fmtBool(r.archived) === "Yes" ? "archived" : "active"} />,
      },
    ],
    []
  );

  const redemptionsCols: Array<Column<RedemptionRow>> = useMemo(
    () => [
      { key: "created_at", header: "When", cell: (r) => <Mono>{fmtMs(r.created_at)}</Mono> },
      { key: "sku", header: "SKU", cell: (r) => <Mono className="text-fg">{r.sku ?? "—"}</Mono> },
      {
        key: "email",
        header: "User",
        cell: (r) => <CopyText value={r.user_id ? String(r.user_id) : null} display={shortHash(r.user_id ? String(r.user_id) : null)} />,
      },
      { key: "points_spent", header: "Points", align: "right", cell: (r) => points(r.points_spent) },
      { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
      { key: "fulfilled_at", header: "Fulfilled", cell: (r) => <Mono>{fmtMs(r.fulfilled_at)}</Mono> },
      {
        key: "metadata",
        header: "Meta",
        cell: (r) => (r.metadata != null && r.metadata !== "" ? <Mono className="text-accent">view →</Mono> : <span className="text-fg-dim">—</span>),
      },
    ],
    []
  );

  const invoicesCols: Array<Column<InvoiceRow>> = useMemo(
    () => [
      { key: "created_at", header: "Created", cell: (r) => <Mono>{fmtMs(r.created_at)}</Mono> },
      { key: "slug", header: "Slug", cell: (r) => <Mono className="text-fg">{r.slug ?? "—"}</Mono> },
      { key: "business", header: "Business", cell: (r) => r.email ?? <CopyText value={r.business_user_id ? String(r.business_user_id) : null} display={shortHash(r.business_user_id ? String(r.business_user_id) : null)} /> },
      { key: "amount_usdc", header: "Amount", align: "right", cell: (r) => <Mono className="text-fg">{fmtUsd(r.amount_usdc)}</Mono> },
      { key: "customer_email", header: "Customer", cell: (r) => <span className="text-fg-muted">{r.customer_email ?? "—"}</span> },
      { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
      { key: "paid_digest", header: "Digest", cell: (r) => <CopyText value={r.paid_digest} display={shortHash(r.paid_digest)} /> },
      { key: "paid_at", header: "Paid", cell: (r) => <Mono>{fmtMs(r.paid_at)}</Mono> },
    ],
    []
  );

  const rows = data?.rows ?? [];

  return (
    <div>
      <SectionHeader
        title="Ledger"
        subtitle="Rewards, savings goals, redemptions & merchant invoices"
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

      <div className="mb-4">
        <FilterTabs options={TAB_OPTIONS} value={tab} onChange={switchTab} />
      </div>

      {error ? <ErrorBanner message={error} onRetry={refetch} /> : null}
      {loading && !data ? <Spinner /> : null}

      {data && data.tab === tab ? (
        <>
          {tab === "rewards" ? (
            <DataTable<RewardRow>
              columns={rewardsCols}
              rows={rows as RewardRow[]}
              rowKey={(r, i) => `${r.id ?? i}`}
              onRowClick={(r) =>
                r.metadata != null && r.metadata !== ""
                  ? setDetail({ title: `Reward · ${r.kind ?? r.id}`, json: r.metadata })
                  : undefined
              }
              empty="No rewards events."
            />
          ) : null}

          {tab === "goals" ? (
            <DataTable<GoalRow>
              columns={goalsCols}
              rows={rows as GoalRow[]}
              rowKey={(r, i) => `${r.id ?? i}`}
              empty="No savings goals."
            />
          ) : null}

          {tab === "redemptions" ? (
            <DataTable<RedemptionRow>
              columns={redemptionsCols}
              rows={rows as RedemptionRow[]}
              rowKey={(r, i) => `${r.id ?? i}`}
              onRowClick={(r) =>
                r.metadata != null && r.metadata !== ""
                  ? setDetail({ title: `Redemption · ${r.sku ?? r.id}`, json: r.metadata })
                  : undefined
              }
              empty="No redemptions."
            />
          ) : null}

          {tab === "invoices" ? (
            <DataTable<InvoiceRow>
              columns={invoicesCols}
              rows={rows as InvoiceRow[]}
              rowKey={(r, i) => `${r.id ?? i}`}
              empty="No invoices."
            />
          ) : null}

          <Pagination page={page} pageCount={pageCount} onPage={setPage} total={data.total} />
        </>
      ) : null}

      <Drawer open={!!detail} onClose={() => setDetail(null)} title={detail?.title ?? "Detail"}>
        {detail ? (
          <div className="space-y-4">
            <Field label="metadata">
              <span className="text-fg-dim">JSON</span>
            </Field>
            <JsonBlock json={prettyJson(detail.json)} />
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

function GoalProgress({
  current,
  target,
}: {
  current: number | string | null;
  target: number | string | null;
}) {
  const c = Number(current ?? 0);
  const t = Number(target ?? 0);
  const pct = t > 0 && Number.isFinite(c) ? Math.min(100, Math.max(0, (c / t) * 100)) : 0;
  return (
    <div className="min-w-[160px]">
      <div className="flex items-center justify-between gap-2 font-mono text-xs">
        <span className="text-fg">{fmtUsd(current)}</span>
        <span className="text-fg-dim">/ {fmtUsd(target)}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-accent-deep" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
