"use client";

import { useEffect, useMemo, useState } from "react";
import { useAdminData } from "../../_lib/fetcher";
import { fmtMs, fmtBool } from "../../_lib/format";
import {
  Card,
  SectionHeader,
  StatCard,
  StatGrid,
  StatusBadge,
  Pill,
  Mono,
  CopyText,
  DataTable,
  type Column,
  SearchInput,
  FilterTabs,
  Pagination,
  Spinner,
  ErrorBanner,
  Drawer,
  Field,
} from "../../_components/ui";

// ─── Shapes ────────────────────────────────────────────────────────

type SignupRow = {
  email: string | null;
  created_at: number | string | null;
  confirmation_sent: boolean | null;
  confirmation_sent_at: number | string | null;
  ip: string | null;
  user_agent: string | null;
  claimed_handle: string | null;
  handle_claimed_at: number | string | null;
  handle_object_id: string | null;
  handle_bound_user_id: string | null;
  handle_bound_at: number | string | null;
};

type LegacyRow = {
  id: number | string | null;
  email: string | null;
  name: string | null;
  country: string | null;
  source: string | null;
  reason: string | null;
  created_at: number | string | null;
  invited_at: number | string | null;
  confirmation_sent_at: number | string | null;
};

type Row = SignupRow | LegacyRow;

type Resp = {
  list: "signups" | "legacy";
  filter: string;
  q: string;
  rows: Row[];
  total: number;
  page: number;
  pageSize: number;
  counts: { signups: number; legacy: number; confirmed: number; claimed: number };
};

type ListKey = "signups" | "legacy";
type FilterKey = "all" | "confirmed" | "unconfirmed" | "claimed";

function isSignup(r: Row): r is SignupRow {
  return "confirmation_sent" in r;
}

// ─── CSV helpers ───────────────────────────────────────────────────

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename: string, headers: string[], records: Array<Array<unknown>>) {
  const lines = [headers.map(csvCell).join(",")];
  for (const rec of records) lines.push(rec.map(csvCell).join(","));
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Page ──────────────────────────────────────────────────────────

export default function WaitlistPage() {
  const [list, setList] = useState<ListKey>("signups");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Row | null>(null);

  // Debounce the search box so we don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Reset paging when the query shape changes.
  useEffect(() => {
    setPage(0);
  }, [list, filter, debouncedQ]);

  // 'claimed' is signups-only — fall back to 'all' when switching to legacy.
  useEffect(() => {
    if (list === "legacy" && filter === "claimed") setFilter("all");
  }, [list, filter]);

  const path = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("list", list);
    sp.set("filter", filter);
    if (debouncedQ) sp.set("q", debouncedQ);
    sp.set("page", String(page));
    return `/api/admin/waitlist?${sp.toString()}`;
  }, [list, filter, debouncedQ, page]);

  const { data, error, loading, refetch } = useAdminData<Resp>(path);

  const counts = data?.counts;
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / (data?.pageSize ?? 50)));

  const filterOptions: Array<{ value: FilterKey; label: string }> =
    list === "signups"
      ? [
          { value: "all", label: "All" },
          { value: "confirmed", label: "Confirmed" },
          { value: "unconfirmed", label: "Unconfirmed" },
          { value: "claimed", label: "Claimed handle" },
        ]
      : [
          { value: "all", label: "All" },
          { value: "confirmed", label: "Confirmed" },
          { value: "unconfirmed", label: "Unconfirmed" },
        ];

  // ─── Columns (differ by list) ────────────────────────────────────

  const signupColumns: Array<Column<Row>> = [
    {
      key: "email",
      header: "Email",
      cell: (r) => <span className="text-fg">{(r as SignupRow).email ?? "—"}</span>,
    },
    {
      key: "created_at",
      header: "Joined",
      cell: (r) => <Mono>{fmtMs((r as SignupRow).created_at)}</Mono>,
    },
    {
      key: "confirmed",
      header: "Confirmed",
      align: "center",
      cell: (r) => (
        <StatusBadge
          status={fmtBool((r as SignupRow).confirmation_sent)}
          tone={(r as SignupRow).confirmation_sent ? "success" : "neutral"}
        />
      ),
    },
    {
      key: "claimed_handle",
      header: "Claimed handle",
      cell: (r) => {
        const h = (r as SignupRow).claimed_handle;
        return h ? <Pill>@{h}</Pill> : <span className="text-fg-dim">—</span>;
      },
    },
    {
      key: "ip",
      header: "IP",
      cell: (r) => {
        const ip = (r as SignupRow).ip;
        return ip ? <Mono>{ip}</Mono> : <span className="text-fg-dim">—</span>;
      },
    },
  ];

  const legacyColumns: Array<Column<Row>> = [
    {
      key: "email",
      header: "Email",
      cell: (r) => <span className="text-fg">{(r as LegacyRow).email ?? "—"}</span>,
    },
    {
      key: "created_at",
      header: "Joined",
      cell: (r) => <Mono>{fmtMs((r as LegacyRow).created_at)}</Mono>,
    },
    {
      key: "name",
      header: "Name",
      cell: (r) => {
        const n = (r as LegacyRow).name;
        return n ? <span className="text-fg-muted">{n}</span> : <span className="text-fg-dim">—</span>;
      },
    },
    {
      key: "country",
      header: "Country",
      align: "center",
      cell: (r) => {
        const c = (r as LegacyRow).country;
        return c ? <Pill>{c}</Pill> : <span className="text-fg-dim">—</span>;
      },
    },
    {
      key: "source",
      header: "Source",
      cell: (r) => {
        const s = (r as LegacyRow).source;
        return s ? <Mono>{s}</Mono> : <span className="text-fg-dim">—</span>;
      },
    },
  ];

  const columns = list === "signups" ? signupColumns : legacyColumns;

  // ─── Export currently-loaded rows ────────────────────────────────

  function onExport() {
    if (!rows.length) return;
    if (list === "signups") {
      const headers = [
        "email",
        "created_at_iso",
        "confirmation_sent",
        "confirmation_sent_at_iso",
        "ip",
        "user_agent",
        "claimed_handle",
        "handle_claimed_at_iso",
        "handle_object_id",
        "handle_bound_user_id",
        "handle_bound_at_iso",
      ];
      const recs = (rows as SignupRow[]).map((r) => [
        r.email,
        toIso(r.created_at),
        fmtBool(r.confirmation_sent),
        toIso(r.confirmation_sent_at),
        r.ip,
        r.user_agent,
        r.claimed_handle,
        toIso(r.handle_claimed_at),
        r.handle_object_id,
        r.handle_bound_user_id,
        toIso(r.handle_bound_at),
      ]);
      downloadCsv(`waitlist-signups-p${page + 1}.csv`, headers, recs);
    } else {
      const headers = [
        "id",
        "email",
        "name",
        "country",
        "source",
        "reason",
        "created_at_iso",
        "invited_at_iso",
        "confirmation_sent_at_iso",
      ];
      const recs = (rows as LegacyRow[]).map((r) => [
        r.id,
        r.email,
        r.name,
        r.country,
        r.source,
        r.reason,
        toIso(r.created_at),
        toIso(r.invited_at),
        toIso(r.confirmation_sent_at),
      ]);
      downloadCsv(`waitlist-legacy-p${page + 1}.csv`, headers, recs);
    }
  }

  return (
    <div>
      <SectionHeader
        title="Waitlist"
        subtitle="Canonical signups + the legacy waitlist table"
        right={
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onExport}
              disabled={!rows.length}
              className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs text-fg-muted hover:text-fg disabled:opacity-40"
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={refetch}
              className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
            >
              Refresh
            </button>
          </div>
        }
      />

      <div className="mb-6">
        <StatGrid>
          <StatCard label="Signups" value={fmtCount(counts?.signups)} />
          <StatCard label="Confirmed" value={fmtCount(counts?.confirmed)} tone="accent" />
          <StatCard label="Handles claimed" value={fmtCount(counts?.claimed)} tone="accent" />
          <StatCard label="Legacy" value={fmtCount(counts?.legacy)} />
        </StatGrid>
      </div>

      <Card className="mb-4" pad>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <FilterTabs<ListKey>
            options={[
              { value: "signups", label: "Signups", count: counts?.signups },
              { value: "legacy", label: "Legacy", count: counts?.legacy },
            ]}
            value={list}
            onChange={setList}
          />
          <SearchInput
            value={q}
            onChange={setQ}
            placeholder={list === "signups" ? "Search email or @handle…" : "Search email…"}
          />
        </div>
        <div className="mt-3">
          <FilterTabs<FilterKey> options={filterOptions} value={filter} onChange={setFilter} />
        </div>
      </Card>

      {error ? <ErrorBanner message={error} onRetry={refetch} /> : null}
      {loading && !data ? <Spinner /> : null}

      {data ? (
        <>
          <DataTable<Row>
            columns={columns}
            rows={rows}
            rowKey={(r, i) =>
              isSignup(r) ? (r.email ?? `s-${i}`) : String((r as LegacyRow).id ?? `l-${i}`)
            }
            onRowClick={(r) => setSelected(r)}
            empty={
              debouncedQ
                ? `No ${list} match “${debouncedQ}”.`
                : `No ${list} yet.`
            }
          />
          <Pagination page={page} pageCount={pageCount} onPage={setPage} total={total} />
        </>
      ) : null}

      <Drawer
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? (isSignup(selected) ? selected.email ?? "Signup" : (selected as LegacyRow).email ?? "Legacy") : ""}
      >
        {selected ? <Detail row={selected} /> : null}
      </Drawer>
    </div>
  );
}

// ─── Drawer detail ─────────────────────────────────────────────────

function Detail({ row }: { row: Row }) {
  if (isSignup(row)) {
    return (
      <div>
        <Field label="Email">{row.email ?? "—"}</Field>
        <Field label="Joined">{fmtMs(row.created_at)}</Field>
        <Field label="Confirmation sent">
          <StatusBadge
            status={fmtBool(row.confirmation_sent)}
            tone={row.confirmation_sent ? "success" : "neutral"}
          />
        </Field>
        <Field label="Confirmed at">{fmtMs(row.confirmation_sent_at)}</Field>
        <Field label="Claimed handle">
          {row.claimed_handle ? <Pill>@{row.claimed_handle}</Pill> : "—"}
        </Field>
        <Field label="Handle claimed at">{fmtMs(row.handle_claimed_at)}</Field>
        <Field label="Handle object id">
          {row.handle_object_id ? <CopyText value={row.handle_object_id} /> : "—"}
        </Field>
        <Field label="Bound user id">
          {row.handle_bound_user_id ? <CopyText value={row.handle_bound_user_id} /> : "—"}
        </Field>
        <Field label="Handle bound at">{fmtMs(row.handle_bound_at)}</Field>
        <Field label="IP">{row.ip ? <Mono>{row.ip}</Mono> : "—"}</Field>
        <Field label="User agent">
          {row.user_agent ? (
            <span className="break-all font-mono text-[11px] text-fg-muted">{row.user_agent}</span>
          ) : (
            "—"
          )}
        </Field>
      </div>
    );
  }
  const r = row as LegacyRow;
  return (
    <div>
      <Field label="ID">{r.id != null ? <Mono>{String(r.id)}</Mono> : "—"}</Field>
      <Field label="Email">{r.email ?? "—"}</Field>
      <Field label="Name">{r.name ?? "—"}</Field>
      <Field label="Country">{r.country ? <Pill>{r.country}</Pill> : "—"}</Field>
      <Field label="Source">{r.source ? <Mono>{r.source}</Mono> : "—"}</Field>
      <Field label="Reason">
        {r.reason ? <span className="break-words text-fg-muted">{r.reason}</span> : "—"}
      </Field>
      <Field label="Joined">{fmtMs(r.created_at)}</Field>
      <Field label="Invited at">{fmtMs(r.invited_at)}</Field>
      <Field label="Confirmation sent at">{fmtMs(r.confirmation_sent_at)}</Field>
    </div>
  );
}

// ─── small utils ───────────────────────────────────────────────────

function fmtCount(n: number | undefined): string {
  return typeof n === "number" ? n.toLocaleString() : "—";
}

function toIso(ms: number | string | null | undefined): string {
  if (ms == null || ms === "") return "";
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n).toISOString();
}
