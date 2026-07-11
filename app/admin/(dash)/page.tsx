"use client";

import Link from "next/link";
import { useAdminData } from "../_lib/fetcher";
import { fmtMs, fmtNum, fmtUsd, tierLabel } from "../_lib/format";
import {
  Card,
  ErrorBanner,
  SectionHeader,
  Spinner,
  StatCard,
  StatGrid,
  StatusBadge,
} from "../_components/ui";

type Overview = {
  generatedAt: number;
  users: {
    total: number;
    new24h: number;
    new7d: number;
    byTier: Array<{ key: string; count: number }>;
    byType: Array<{ key: string; count: number }>;
  };
  waitlist: { total: number; confirmed: number; claimedHandles: number; legacy: number };
  transactions: {
    onchain: number;
    onchain24h: number;
    transfers: number;
    linq: number;
    success: number;
    pending: number;
    failed: number;
    transfersByState: Array<{ key: string; count: number }>;
    linqByStatus: Array<{ key: string; count: number }>;
    parked: number;
  };
  commerce: {
    invoicesTotal: number;
    invoicesPaid: number;
    rewardsEvents: number;
    redemptions: number;
    savingsGoals: number;
  };
  compliance: {
    kycIntents: number;
    travelRecords: number;
    floatPools: number;
    floatUsdc: number;
    roundupPending: number;
  };
};

export default function OverviewPage() {
  const { data, error, loading, refetch } = useAdminData<Overview>("/api/admin/overview");

  return (
    <div>
      <SectionHeader
        title="Overview"
        subtitle={
          data ? `Live from Postgres · generated ${fmtMs(data.generatedAt)}` : "Live from Postgres"
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

      {error ? <ErrorBanner message={error} onRetry={refetch} /> : null}
      {loading && !data ? <Spinner /> : null}

      {data ? (
        <div className="space-y-7">
          {/* Headline KPIs */}
          <StatGrid>
            <StatCard label="Total users" value={fmtNum(data.users.total)} hint={`+${data.users.new24h} in 24h · +${data.users.new7d} in 7d`} />
            <StatCard label="Waitlist signups" value={fmtNum(data.waitlist.total)} hint={`${data.waitlist.confirmed} confirmed · ${data.waitlist.claimedHandles} handles`} />
            <StatCard label="On-chain txs" value={fmtNum(data.transactions.onchain)} hint={`+${data.transactions.onchain24h} in 24h`} />
            <StatCard label="Cross-border transfers" value={fmtNum(data.transactions.transfers)} hint={`${data.transactions.linq} Linq off-ramp payouts`} />
          </StatGrid>

          {/* Tx status split */}
          <Card>
            <div className="mb-4 text-sm font-medium text-fg">Transaction status (transfers + payouts)</div>
            <StatGrid>
              <StatCard label="Successful" value={fmtNum(data.transactions.success)} tone="accent" />
              <StatCard label="Pending" value={fmtNum(data.transactions.pending)} tone="warn" />
              <StatCard label="Failed" value={fmtNum(data.transactions.failed)} tone="danger" />
              <StatCard label="Parked funds" value={fmtNum(data.transactions.parked)} tone={data.transactions.parked > 0 ? "danger" : "default"} hint="post-commit fiat-out failures" />
            </StatGrid>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <BreakdownList title="transfers.state" rows={data.transactions.transfersByState} />
              <BreakdownList title="linq_offramps.status" rows={data.transactions.linqByStatus} />
            </div>
            <Link href="/admin/transactions" className="mt-4 inline-block text-xs text-accent hover:underline">
              View all transactions →
            </Link>
          </Card>

          {/* Users by tier / type */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <div className="mb-3 text-sm font-medium text-fg">Users by KYC tier</div>
              <div className="space-y-2">
                {data.users.byTier.map((t) => (
                  <div key={t.key} className="flex items-center justify-between text-sm">
                    <span className="text-fg-muted">{tierLabel(t.key)}</span>
                    <span className="font-mono text-fg">{fmtNum(t.count)}</span>
                  </div>
                ))}
              </div>
              <Link href="/admin/users" className="mt-4 inline-block text-xs text-accent hover:underline">
                Explore users →
              </Link>
            </Card>
            <Card>
              <div className="mb-3 text-sm font-medium text-fg">Accounts by type</div>
              <div className="space-y-2">
                {data.users.byType.map((t) => (
                  <div key={t.key} className="flex items-center justify-between text-sm">
                    <span className="capitalize text-fg-muted">{t.key}</span>
                    <span className="font-mono text-fg">{fmtNum(t.count)}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* Compliance + commerce */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <div className="mb-3 text-sm font-medium text-fg">Compliance & treasury</div>
              <MiniRow label="KYC upgrade intents" value={fmtNum(data.compliance.kycIntents)} href="/admin/compliance" />
              <MiniRow label="Travel Rule records" value={fmtNum(data.compliance.travelRecords)} href="/admin/compliance" />
              <MiniRow label="Float pools" value={fmtNum(data.compliance.floatPools)} href="/admin/compliance" />
              <MiniRow label="USDC float inventory" value={fmtUsd(data.compliance.floatUsdc)} href="/admin/compliance" />
              <MiniRow
                label="Round-ups pending"
                value={<StatusBadge status={data.compliance.roundupPending > 0 ? `${data.compliance.roundupPending} pending` : "drained"} />}
                href="/admin/compliance"
              />
            </Card>
            <Card>
              <div className="mb-3 text-sm font-medium text-fg">Commerce & rewards</div>
              <MiniRow label="Invoices" value={`${fmtNum(data.commerce.invoicesPaid)} paid / ${fmtNum(data.commerce.invoicesTotal)}`} href="/admin/ledger" />
              <MiniRow label="Rewards events" value={fmtNum(data.commerce.rewardsEvents)} href="/admin/ledger" />
              <MiniRow label="Redemptions" value={fmtNum(data.commerce.redemptions)} href="/admin/ledger" />
              <MiniRow label="Active savings goals" value={fmtNum(data.commerce.savingsGoals)} href="/admin/ledger" />
            </Card>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BreakdownList({ title, rows }: { title: string; rows: Array<{ key: string; count: number }> }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2/40 p-3">
      <div className="mb-2 font-mono text-[11px] text-fg-dim">{title}</div>
      {rows.length === 0 ? (
        <div className="text-xs text-fg-dim">No rows.</div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.key} className="flex items-center justify-between gap-2 text-sm">
              <StatusBadge status={r.key} />
              <span className="font-mono text-fg">{fmtNum(r.count)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MiniRow({ label, value, href }: { label: string; value: React.ReactNode; href: string }) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between border-b border-line/50 py-2 text-sm last:border-0 hover:text-fg"
    >
      <span className="text-fg-muted">{label}</span>
      <span className="font-mono text-fg">{value}</span>
    </Link>
  );
}
