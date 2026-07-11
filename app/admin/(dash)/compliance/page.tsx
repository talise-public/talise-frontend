"use client";

import { useState } from "react";
import { useAdminData } from "../../_lib/fetcher";
import { fmtMs, fmtUsd, fmtCcy, tierLabel, prettyJson } from "../../_lib/format";
import {
  Card,
  SectionHeader,
  StatusBadge,
  Pill,
  CopyText,
  DataTable,
  type Column,
  FilterTabs,
  Pagination,
  Spinner,
  ErrorBanner,
  EmptyState,
  JsonBlock,
  Drawer,
  Field,
} from "../../_components/ui";

// ─── Tabs ────────────────────────────────────────────────────────────

type Tab = "kyc" | "travel" | "float" | "roundup";

const TABS: Array<{ value: Tab; label: string }> = [
  { value: "kyc", label: "KYC intents" },
  { value: "travel", label: "Travel Rule" },
  { value: "float", label: "Float pools" },
  { value: "roundup", label: "Round-up queue" },
];

// ─── Row shapes ──────────────────────────────────────────────────────

type KycRow = {
  id: string | number;
  user_id: string;
  email: string | null;
  from_tier: number | string | null;
  requested_tier: number | string | null;
  ekyc_provider: string | null;
  ekyc_ref: string | null;
  ekyc_status: string | null;
  created_at: number | string | null;
};

type TravelRow = {
  id: string | number;
  user_id: string;
  route: string | null;
  obligation: string | null;
  amount_usd: number | string | null;
  recipient_kind: string | null;
  beneficiary_address: string | null;
  network_transfer_id: string | null;
  status: string | null;
  ivms101_json: unknown;
  created_at: number | string | null;
};

type FloatRow = {
  id: string | number;
  corridor: string | null;
  currency: string | null;
  leg: string | null;
  fiat_in_pool: number | string | null;
  fiat_out_pool: number | string | null;
  usdc_pool: number | string | null;
  segregated: boolean | number | string | null;
  reconciled_at: number | string | null;
  created_at: number | string | null;
  updated_at: number | string | null;
};

type RoundupRow = {
  id: string | number;
  user_id: string;
  amount_usd: number | string | null;
  created_at: number | string | null;
  processed_at: number | string | null;
  tx_digest: string | null;
};

type ApiResp<Row> = {
  tab: Tab;
  rows: Row[];
  total: number;
  page: number;
  pageSize: number;
};

// ─── Page ────────────────────────────────────────────────────────────

export default function CompliancePage() {
  const [tab, setTab] = useState<Tab>("kyc");
  const [page, setPage] = useState(0);

  function onTab(next: Tab) {
    setTab(next);
    setPage(0);
  }

  return (
    <div>
      <SectionHeader
        title="Compliance & treasury"
        subtitle="KYC upgrades, Travel Rule disclosures, float inventory and the round-up sweep queue."
      />

      <div className="mb-4">
        <FilterTabs<Tab> options={TABS} value={tab} onChange={onTab} />
      </div>

      {tab === "kyc" ? <KycTab page={page} onPage={setPage} /> : null}
      {tab === "travel" ? <TravelTab page={page} onPage={setPage} /> : null}
      {tab === "float" ? <FloatTab /> : null}
      {tab === "roundup" ? <RoundupTab page={page} onPage={setPage} /> : null}
    </div>
  );
}

// ─── Shared loading frame ────────────────────────────────────────────

function Frame<Row>({
  state,
  children,
}: {
  state: ReturnType<typeof useAdminData<ApiResp<Row>>>;
  children: (data: ApiResp<Row>) => React.ReactNode;
}) {
  const { data, error, loading, refetch } = state;
  if (error) return <ErrorBanner message={error} onRetry={refetch} />;
  if (loading && !data) return <Spinner />;
  if (!data) return null;
  return <>{children(data)}</>;
}

function pageCount(total: number, pageSize: number) {
  return Math.max(1, Math.ceil(total / pageSize));
}

// ─── KYC intents ─────────────────────────────────────────────────────

function KycTab({ page, onPage }: { page: number; onPage: (p: number) => void }) {
  const state = useAdminData<ApiResp<KycRow>>(`/api/admin/compliance?tab=kyc&page=${page}`);

  const columns: Array<Column<KycRow>> = [
    {
      key: "email",
      header: "User",
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate text-fg-muted">{r.email ?? "—"}</div>
          <CopyText value={r.user_id} className="text-fg-dim" />
        </div>
      ),
    },
    {
      key: "tier",
      header: "Tier change",
      cell: (r) => (
        <span className="font-mono text-xs text-fg-muted">
          {tierLabel(r.from_tier)} <span className="text-fg-dim">→</span> {tierLabel(r.requested_tier)}
        </span>
      ),
    },
    {
      key: "provider",
      header: "Provider",
      cell: (r) => (
        <div className="min-w-0">
          <Pill>{r.ekyc_provider ?? "—"}</Pill>
          {r.ekyc_ref ? (
            <div className="mt-1">
              <CopyText value={r.ekyc_ref} className="text-fg-dim" />
            </div>
          ) : null}
        </div>
      ),
    },
    { key: "status", header: "eKYC status", cell: (r) => <StatusBadge status={r.ekyc_status} /> },
    {
      key: "created_at",
      header: "Requested",
      align: "right",
      cell: (r) => <span className="text-fg-dim">{fmtMs(r.created_at)}</span>,
    },
  ];

  return (
    <Frame<KycRow> state={state}>
      {(data) => (
        <>
          <DataTable<KycRow>
            columns={columns}
            rows={data.rows}
            rowKey={(r) => r.id}
            empty="No KYC upgrade intents yet."
          />
          <Pagination
            page={data.page}
            pageCount={pageCount(data.total, data.pageSize)}
            onPage={onPage}
            total={data.total}
          />
        </>
      )}
    </Frame>
  );
}

// ─── Travel Rule ─────────────────────────────────────────────────────

function TravelTab({ page, onPage }: { page: number; onPage: (p: number) => void }) {
  const state = useAdminData<ApiResp<TravelRow>>(`/api/admin/compliance?tab=travel&page=${page}`);
  const [selected, setSelected] = useState<TravelRow | null>(null);

  const columns: Array<Column<TravelRow>> = [
    { key: "route", header: "Route", cell: (r) => <Pill>{r.route ?? "—"}</Pill> },
    {
      key: "obligation",
      header: "Obligation",
      cell: (r) => <span className="text-fg-muted">{r.obligation ?? "—"}</span>,
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      cell: (r) => <span className="font-mono text-fg">{fmtUsd(r.amount_usd)}</span>,
    },
    {
      key: "recipient_kind",
      header: "Recipient",
      cell: (r) => <span className="text-fg-muted">{r.recipient_kind ?? "—"}</span>,
    },
    { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: "created_at",
      header: "Recorded",
      align: "right",
      cell: (r) => <span className="text-fg-dim">{fmtMs(r.created_at)}</span>,
    },
  ];

  return (
    <Frame<TravelRow> state={state}>
      {(data) => (
        <>
          <DataTable<TravelRow>
            columns={columns}
            rows={data.rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => setSelected(r)}
            empty="No Travel Rule records yet."
          />
          <Pagination
            page={data.page}
            pageCount={pageCount(data.total, data.pageSize)}
            onPage={onPage}
            total={data.total}
          />

          <Drawer
            open={selected != null}
            onClose={() => setSelected(null)}
            title="Travel Rule record"
          >
            {selected ? (
              <div className="space-y-5">
                <div>
                  <Field label="Record ID">
                    <CopyText value={String(selected.id)} />
                  </Field>
                  <Field label="User">
                    <CopyText value={selected.user_id} />
                  </Field>
                  <Field label="Route">
                    <Pill>{selected.route ?? "—"}</Pill>
                  </Field>
                  <Field label="Obligation">{selected.obligation ?? "—"}</Field>
                  <Field label="Amount">{fmtUsd(selected.amount_usd)}</Field>
                  <Field label="Recipient kind">{selected.recipient_kind ?? "—"}</Field>
                  <Field label="Status">
                    <StatusBadge status={selected.status} />
                  </Field>
                  <Field label="Beneficiary">
                    <CopyText value={selected.beneficiary_address} />
                  </Field>
                  <Field label="Network transfer">
                    <CopyText value={selected.network_transfer_id} />
                  </Field>
                  <Field label="Recorded">{fmtMs(selected.created_at)}</Field>
                </div>

                <div>
                  <div className="mb-2 text-[11px] uppercase tracking-wide text-fg-dim">
                    IVMS101 payload
                  </div>
                  <JsonBlock json={prettyJson(selected.ivms101_json)} />
                </div>
              </div>
            ) : null}
          </Drawer>
        </>
      )}
    </Frame>
  );
}

// ─── Float pools ─────────────────────────────────────────────────────

function FloatTab() {
  // Float pools are a small fixed set — show as cards, no pagination needed.
  const state = useAdminData<ApiResp<FloatRow>>(`/api/admin/compliance?tab=float&page=0`);

  return (
    <Frame<FloatRow> state={state}>
      {(data) =>
        data.rows.length === 0 ? (
          <EmptyState>No float pools configured.</EmptyState>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.rows.map((r) => {
              const segregated = isTrue(r.segregated);
              return (
                <Card key={String(r.id)}>
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-mono text-sm text-fg">{r.corridor ?? "—"}</div>
                      <div className="mt-0.5 text-xs text-fg-dim">
                        {(r.currency ?? "—")} · {(r.leg ?? "—")}
                      </div>
                    </div>
                    <Pill
                      className={
                        segregated
                          ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                          : "border-accent-deep/50 bg-accent-deep/15 text-accent"
                      }
                    >
                      {segregated ? "segregated" : "operating"}
                    </Pill>
                  </div>

                  <div className="space-y-1.5">
                    <PoolRow label="USDC pool" value={fmtUsd(r.usdc_pool)} strong />
                    <PoolRow
                      label="Fiat in"
                      value={fmtCcy(r.fiat_in_pool, r.currency ?? "")}
                    />
                    <PoolRow
                      label="Fiat out"
                      value={fmtCcy(r.fiat_out_pool, r.currency ?? "")}
                    />
                  </div>

                  <div className="mt-3 border-t border-line/50 pt-2 text-[11px] text-fg-dim">
                    Reconciled {fmtMs(r.reconciled_at)}
                  </div>
                </Card>
              );
            })}
          </div>
        )
      }
    </Frame>
  );
}

function PoolRow({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-fg-dim">{label}</span>
      <span className={`font-mono ${strong ? "text-fg" : "text-fg-muted"}`}>{value}</span>
    </div>
  );
}

function isTrue(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true" || v === "t";
}

// ─── Round-up queue ──────────────────────────────────────────────────

function RoundupTab({ page, onPage }: { page: number; onPage: (p: number) => void }) {
  const state = useAdminData<ApiResp<RoundupRow>>(`/api/admin/compliance?tab=roundup&page=${page}`);

  const columns: Array<Column<RoundupRow>> = [
    {
      key: "user_id",
      header: "User",
      cell: (r) => <CopyText value={r.user_id} className="text-fg-muted" />,
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      cell: (r) => <span className="font-mono text-fg">{fmtUsd(r.amount_usd)}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => <StatusBadge status={r.processed_at == null ? "pending" : "processed"} />,
    },
    {
      key: "tx_digest",
      header: "Tx digest",
      cell: (r) => <CopyText value={r.tx_digest} />,
    },
    {
      key: "created_at",
      header: "Queued",
      align: "right",
      cell: (r) => <span className="text-fg-dim">{fmtMs(r.created_at)}</span>,
    },
    {
      key: "processed_at",
      header: "Processed",
      align: "right",
      cell: (r) => <span className="text-fg-dim">{fmtMs(r.processed_at)}</span>,
    },
  ];

  return (
    <Frame<RoundupRow> state={state}>
      {(data) => (
        <>
          <DataTable<RoundupRow>
            columns={columns}
            rows={data.rows}
            rowKey={(r) => r.id}
            empty="Round-up queue is empty."
          />
          <Pagination
            page={data.page}
            pageCount={pageCount(data.total, data.pageSize)}
            onPage={onPage}
            total={data.total}
          />
        </>
      )}
    </Frame>
  );
}
