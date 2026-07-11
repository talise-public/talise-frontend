"use client";

import { useEffect, useMemo, useState } from "react";
import { useAdminData, adminFetch } from "../../_lib/fetcher";
import { fmtMs, fmtNum, fmtUsd, fmtBool, tierLabel, fmtRelative } from "../../_lib/format";
import {
  Card,
  SectionHeader,
  StatusBadge,
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

type UserRow = {
  id: number;
  email: string | null;
  talise_username: string | null;
  account_type: string | null;
  country: string | null;
  kyc_tier: number | null;
  points_total: number | string | null;
  lifetime_sent_usd: number | string | null;
  created_at: number | string | null;
  last_seen_at: number | string | null;
};

type ListResponse = {
  rows: UserRow[];
  total: number;
  page: number;
  pageSize: number;
};

type UserDetail = {
  user: Record<string, unknown> & { id: number };
  stats: { txCount: number; transferCount: number };
};

const TIER_TABS = [
  { value: "all", label: "All tiers" },
  { value: "0", label: "T0" },
  { value: "1", label: "T1" },
  { value: "2", label: "T2" },
  { value: "3", label: "T3" },
] as const;

const TYPE_TABS = [
  { value: "all", label: "All" },
  { value: "personal", label: "Personal" },
  { value: "business", label: "Business" },
] as const;

type TierValue = (typeof TIER_TABS)[number]["value"];
type TypeValue = (typeof TYPE_TABS)[number]["value"];

export default function UsersPage() {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [tier, setTier] = useState<TierValue>("all");
  const [accountType, setAccountType] = useState<TypeValue>("all");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Debounce the search box (~300ms).
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to page 0 whenever any filter changes.
  useEffect(() => {
    setPage(0);
  }, [debounced, tier, accountType]);

  const path = useMemo(() => {
    const p = new URLSearchParams();
    if (debounced) p.set("q", debounced);
    if (tier !== "all") p.set("tier", tier);
    if (accountType !== "all") p.set("type", accountType);
    p.set("page", String(page));
    return `/api/admin/users?${p.toString()}`;
  }, [debounced, tier, accountType, page]);

  const { data, error, loading, refetch } = useAdminData<ListResponse>(path);

  const pageSize = data?.pageSize ?? 50;
  const pageCount = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  const columns: Array<Column<UserRow>> = [
    {
      key: "email",
      header: "Email",
      cell: (r) => <span className="text-fg">{r.email || "—"}</span>,
    },
    {
      key: "handle",
      header: "Handle",
      cell: (r) =>
        r.talise_username ? (
          <Mono>@{r.talise_username}</Mono>
        ) : (
          <span className="text-fg-dim">—</span>
        ),
    },
    {
      key: "tier",
      header: "Tier",
      cell: (r) => <StatusBadge status={tierLabel(r.kyc_tier)} />,
    },
    {
      key: "country",
      header: "Country",
      cell: (r) => <span>{r.country || "—"}</span>,
    },
    {
      key: "points",
      header: "Points",
      align: "right",
      cell: (r) => <Mono>{fmtNum(r.points_total)}</Mono>,
    },
    {
      key: "lifetime_sent",
      header: "Lifetime sent",
      align: "right",
      cell: (r) => <Mono>{fmtUsd(r.lifetime_sent_usd)}</Mono>,
    },
    {
      key: "created_at",
      header: "Joined",
      align: "right",
      cell: (r) => <span className="whitespace-nowrap">{fmtMs(r.created_at)}</span>,
    },
  ];

  return (
    <div>
      <SectionHeader
        title="Users"
        subtitle={
          data ? `${fmtNum(data.total)} matching accounts` : "All Talise accounts"
        }
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

      <Card className="mb-4">
        <div className="flex flex-col gap-3">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search email, handle, address, name…"
          />
          <div className="flex flex-col gap-2">
            <FilterTabs<TierValue>
              options={TIER_TABS.map((t) => ({ value: t.value, label: t.label }))}
              value={tier}
              onChange={setTier}
            />
            <FilterTabs<TypeValue>
              options={TYPE_TABS.map((t) => ({ value: t.value, label: t.label }))}
              value={accountType}
              onChange={setAccountType}
            />
          </div>
        </div>
      </Card>

      {error ? <ErrorBanner message={error} onRetry={refetch} /> : null}
      {loading && !data ? <Spinner /> : null}

      {data ? (
        <>
          <DataTable<UserRow>
            columns={columns}
            rows={data.rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => setSelectedId(r.id)}
            empty="No users match these filters."
          />
          <Pagination
            page={data.page}
            pageCount={pageCount}
            onPage={setPage}
            total={data.total}
          />
        </>
      ) : null}

      <UserDrawer
        id={selectedId}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}

// ─── Detail drawer ───────────────────────────────────────────────────

function UserDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const path = id != null ? `/api/admin/users?id=${id}` : null;
  const { data, error, loading } = useAdminData<UserDetail>(path ?? "/api/admin/users?id=__none__");
  const open = id != null;

  // Only show fetched data once we actually have a selection.
  const detail = open ? data : null;
  const u = detail?.user ?? null;

  const title = u
    ? (u.email as string) || (u.talise_username ? `@${u.talise_username}` : `User #${u.id}`)
    : "User";

  return (
    <Drawer open={open} onClose={onClose} title={title}>
      {error && open ? <ErrorBanner message={error} /> : null}
      {loading && open && !detail ? <Spinner /> : null}

      {u ? (
        <div className="space-y-6">
          <Group title="Identity">
            <Field label="ID">
              <Mono>{String(u.id)}</Mono>
            </Field>
            <Field label="Email">{str(u.email)}</Field>
            <Field label="Name">{str(u.name)}</Field>
            <Field label="Handle">
              {u.talise_username ? <Mono>@{String(u.talise_username)}</Mono> : "—"}
            </Field>
            <Field label="Country">{str(u.country)}</Field>
            <Field label="Sui address">
              <CopyText value={asStr(u.sui_address)} />
            </Field>
            <Field label="Google sub">
              <CopyText value={asStr(u.google_sub)} />
            </Field>
            <Field label="Salt">{str(u.salt)}</Field>
          </Group>

          <Group title="Account">
            <Field label="Account type">
              <span className="capitalize">{str(u.account_type) === "—" ? "personal" : str(u.account_type)}</span>
            </Field>
            <Field label="Business name">{str(u.business_name)}</Field>
            <Field label="Business handle">{str(u.business_handle)}</Field>
            <Field label="Business industry">{str(u.business_industry)}</Field>
            <Field label="Interests">{str(u.interests)}</Field>
            <Field label="Payment registry id">
              <CopyText value={asStr(u.payment_registry_id)} />
            </Field>
            <Field label="Spot BM id">{str(u.spot_bm_id)}</Field>
            <Field label="Created">{fmtMs(u.created_at as number | string | null)}</Field>
            <Field label="Last seen">
              {u.last_seen_at ? (
                <span>
                  {fmtMs(u.last_seen_at as number | string)}{" "}
                  <span className="text-fg-dim">({fmtRelative(u.last_seen_at as number | string)})</span>
                </span>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Notified">{fmtMs(u.notified_at as number | string | null)}</Field>
          </Group>

          <Group title="Referral & points">
            <Field label="Referral code">
              {u.referral_code ? <Mono>{String(u.referral_code)}</Mono> : "—"}
            </Field>
            <Field label="Referred by (user id)">{str(u.referred_by_user_id)}</Field>
            <Field label="Referral count">
              <Mono>{fmtNum(u.referral_count as number | string | null)}</Mono>
            </Field>
            <Field label="Points total">
              <Mono>{fmtNum(u.points_total as number | string | null)}</Mono>
            </Field>
          </Group>

          <Group title="Round-up settings">
            <Field label="Round-up enabled">{fmtBool(u.roundup_enabled)}</Field>
            <Field label="Round-up percentage">{str(u.roundup_percentage)}</Field>
            <Field label="Lifetime sent">
              <Mono>{fmtUsd(u.lifetime_sent_usd as number | string | null)}</Mono>
            </Field>
            <Field label="Lifetime saved">
              <Mono>{fmtUsd(u.lifetime_saved_usd as number | string | null)}</Mono>
            </Field>
            <Field label="Round-up saved">
              <Mono>{fmtUsd(u.roundup_saved_usd as number | string | null)}</Mono>
            </Field>
          </Group>

          <Group title="KYC">
            <Field label="Tier">
              <StatusBadge status={tierLabel(u.kyc_tier as number | string | null)} />
            </Field>
          </Group>

          <Group title="Activity">
            <Field label="On-chain txs">
              <Mono>{fmtNum(detail?.stats.txCount ?? 0)}</Mono>
            </Field>
            <Field label="Cross-border transfers">
              <Mono>{fmtNum(detail?.stats.transferCount ?? 0)}</Mono>
            </Field>
          </Group>
        </div>
      ) : null}
    </Drawer>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wide text-fg-dim">{title}</div>
      <div className="rounded-lg border border-line bg-surface-2/30 px-3">{children}</div>
    </div>
  );
}

/** Render an unknown DB value as a display string, "—" when empty. */
function str(v: unknown): string {
  if (v == null || v === "") return "—";
  return String(v);
}

/** Coerce an unknown DB value to a string|null for CopyText. */
function asStr(v: unknown): string | null {
  if (v == null || v === "") return null;
  return String(v);
}
