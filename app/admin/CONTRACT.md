# Talise Admin Dashboard — build contract

Internal, read-only operational dashboard. Local-first (`pnpm dev` → `/admin`),
also deployable. Dark Talise palette. Every section is one **page** (client
component) + one **API route** (server, gated). Pages render real Postgres data.

## Auth (already built — do not modify)

- `lib/admin-auth.ts` — gate. Three ways in: dev-open (non-prod, no `ADMIN_TOKEN`),
  token cookie (`/admin/login`), allowlisted Google session.
- **Every** admin API route must start with:
  ```ts
  import { requireAdminApi } from "@/lib/admin-auth";
  export const dynamic = "force-dynamic";
  export async function GET(req: Request) {
    const denied = await requireAdminApi(req);
    if (denied) return denied;
    // …
  }
  ```
- Pages are inside the gated `(dash)` route group, so they're already protected.

## File layout & ownership

- Pages: `web/app/admin/(dash)/<section>/page.tsx` → URL `/admin/<section>`.
- APIs: `web/app/api/admin/<section>/route.ts` → `/api/admin/<section>`.
- A section may add its own helpers under `web/app/admin/(dash)/<section>/` (e.g.
  `_parts.tsx`). **Do NOT** edit shared files, the layout, the shell, other
  sections, or anything outside your assigned paths. Add, don't change.

## Imports (path depth matters — route group `(dash)` is a real dir)

From a section page at `app/admin/(dash)/<section>/page.tsx`:
```ts
import { useAdminData, adminFetch } from "../../_lib/fetcher";
import { fmtMs, fmtUsd, fmtNum, fmtCcy, shortHash, fmtBool, tierLabel, prettyJson, fmtRelative, fmtDay } from "../../_lib/format";
import { Card, SectionHeader, StatCard, StatGrid, StatusBadge, statusTone, Pill, Mono, CopyText, DataTable, type Column, SearchInput, FilterTabs, Pagination, Spinner, ErrorBanner, EmptyState, JsonBlock, Drawer, Field } from "../../_components/ui";
```

## Shared UI primitives (in `_components/ui.tsx`)

- `Card`, `SectionHeader{title,subtitle,right}`, `StatGrid`, `StatCard{label,value,hint,tone}`
  (tone: default|accent|danger|warn).
- `StatusBadge{status}` auto-colours by status string; `statusTone(s)` if you need the tone.
- `DataTable<Row>{columns,rows,rowKey,onRowClick,empty}` with `Column<Row>={key,header,cell,className,align}`.
- `SearchInput{value,onChange,placeholder}`, `FilterTabs<V>{options,value,onChange}`,
  `Pagination{page,pageCount,onPage,total}`.
- `Spinner`, `ErrorBanner{message,onRetry}`, `EmptyState`.
- `Drawer{open,onClose,title}` + `Field{label}` for row detail. `JsonBlock{json}` for metadata.
- `CopyText{value,display}`, `Mono`, `Pill`.

## Data fetching (client pages)

```tsx
"use client";
const { data, error, loading, refetch } = useAdminData<MyType>("/api/admin/<section>?page=0");
```
Render: `ErrorBanner` on error, `Spinner` while loading && !data, then content.

## DB access (API routes)

`import { db, ensureSchema } from "@/lib/db";` — libsql-shaped:
`const r = await db().execute({ sql, args }); r.rows // Array<Record<string,unknown>>`.
Postgres placeholders are `$1,$2,…`. Call `await ensureSchema().catch(()=>{})` once at
the top so tables exist on a cold DB. COUNT/NUMERIC come back as strings — `Number()` them.
Always paginate (LIMIT/OFFSET, default 50) and return `{ rows, total, page, pageSize }`.
Validate/whitelist any user-supplied column/sort/table names — never interpolate raw input
into SQL. Read-only: SELECT only. No INSERT/UPDATE/DELETE.

## Timestamps & money

All `*_at` / `*_ms` columns are BIGINT epoch **milliseconds** → `fmtMs`. Money columns vary:
`users.lifetime_*_usd` etc. are USD doubles → `fmtUsd`; `transfers/paga` amounts are NUMERIC
strings; tx_history.amount is a string. Use `fmtCcy(v, ccy)` for non-USD.

## Tailwind v4 tokens

`bg`, `surface`, `surface-2`, `line`, `fg`, `fg-muted`, `fg-dim`, `accent` (#CAFFB8),
`accent-deep` (#4B8A37), `danger`. Mono = `font-mono`. e.g. `bg-surface border-line text-fg-muted`.

## Database schema (ground truth)

- **users**: id, google_sub, email, name, picture, sui_address, salt, country, created_at,
  last_seen_at, notified_at, account_type, business_name, business_handle, business_industry,
  talise_username, interests, notify_on_receive, spot_bm_id, payment_registry_id, referral_code,
  referred_by_user_id, referral_count, points_total, roundup_enabled, roundup_percentage,
  lifetime_sent_usd, lifetime_saved_usd, roundup_saved_usd, talise_vault_id (dormant),
  talise_vault_subname_repointed (dormant), kyc_tier (0..3, NULL=0).
- **tx_history**: id, user_id, digest (unique), kind, amount, asset, recipient, memo,
  receipt_object_id, created_at. (Recorded post-confirmation → all "successful".)
- **invoices**: id, business_user_id, slug, amount_usdc, reference, customer_email,
  status (open|paid|…), created_at, paid_at, paid_digest, paid_by_address, receipt_object_id.
- **rewards_events**: id, user_id, kind, points, metadata(json), created_at.
- **savings_goals**: id, user_id, name, target_usd, current_usd, deadline_ms, color, created_at, archived(0|1).
- **redemptions**: id, user_id, sku, points_spent, status (pending|…), metadata(json), created_at, fulfilled_at.
- **waitlist** (legacy/dead): id, email, created_at, source, invited_at, name, country, reason,
  confirmation_sent_at, confirmation_message_id.
- **waitlist_signups** (canonical): email(PK), created_at, ip, user_agent, confirmation_sent(bool),
  confirmation_sent_at, claimed_handle, handle_claimed_at, handle_object_id, handle_bound_user_id, handle_bound_at.
- **paga_offramps**: id(PK text), user_id(text), usdsui_amount, ngn_amount, fx_rate, bank_code,
  bank_account_number, bank_account_name, paga_reference, status, status_reason, created_at,
  debited_at, settled_at, failed_at.
- **transfers** (cross-border state machine): id(PK text), user_id(text), kind, provider, state
  (quoted→debited→onchain_settling→onchain_settled→fiat_out_pending→settled, +failed/refunded),
  source_currency, dest_currency, usdsui_amount, source_amount, dest_amount, fx_rate, onchain_digest,
  provider_reference, state_reason, parked_funds(bool), metadata(json), created_at, updated_at,
  debited_at, onchain_settled_at, settled_at, failed_at.
- **roundup_queue**: id, user_id, amount_usd, created_at, processed_at(NULL=pending), tx_digest.
- **float_pools**: id, corridor, currency, leg, fiat_in_pool, fiat_out_pool, usdc_pool,
  segregated(bool), reconciled_at, created_at, updated_at.
- **kyc_upgrade_intents**: id, user_id, from_tier, requested_tier, ekyc_provider, ekyc_ref,
  ekyc_status (pending|approved|rejected), created_at.
- **travel_rule_records**: id, user_id, route (INTERNAL|EXTERNAL_VASP|UNHOSTED), obligation,
  amount_usd, recipient_kind, beneficiary_address, ivms101_json, network_transfer_id, status, created_at.
- **mobile_sessions** (from lib/mobile-sessions.ts; may not exist on cold DB — tolerate absence):
  device-bound mobile session tokens.

## Verify before finishing

`cd web && pnpm exec tsc --noEmit` must be clean for your files. Do not run `pnpm build`
(it races with sibling agents). Keep everything read-only and admin-gated.
