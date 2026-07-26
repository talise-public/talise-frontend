# Per-user monitoring: what the operator has to set up

**Status:** spec, not a build. Nothing here has been implemented.
**Audience:** whoever runs `/admin` locally against production Postgres.
**Scope:** what it takes to answer *"who are my users and what are they
doing"* without endangering the money rails.

> **Why this file lives here.** `/docs/` is gitignored in this repo, and
> `web/app/admin/` is deliberately **untracked** (commit `b19a252a`) so the
> ops dashboard can never deploy. Neither can carry a document that has to
> survive. So the spec sits next to the rewards engine, which is the other
> half of the abuse story, and travels with the code.

---

## 0. The headline

**Provision a dedicated read-only Postgres role and give `/admin` its own
small pool through a separate `DATABASE_URL_ANALYTICS`.** Everything else in
this document is secondary.

Today that separation does not exist:

- `web/lib/db.ts:124` reads **`DATABASE_URL` and nothing else**. There is no
  `POSTGRES_URL`, no `DATABASE_URL_ANALYTICS`, no read-replica support.
- The pool is `max: 8` per instance (`web/lib/db.ts:161`) and is **shared with
  every money path in the app** — sends, limit checks, offramp state.
- There is **no `statement_timeout` anywhere in the repo.** The only
  server-side timeout is a `SET LOCAL lock_timeout = '2s'` in
  `web/lib/analytics/growth-revenue.ts:79`. Every other "timeout" is a
  client-side `Promise.race` that abandons the *promise* while the query keeps
  running on the server and keeps holding its connection.
- `/admin`'s read-only discipline is a **convention, not a permission**.
  `web/app/admin/CONTRACT.md` says "Read-only: SELECT only. No
  INSERT/UPDATE/DELETE" — but the role it connects as can do anything, and the
  dashboard is the surface most likely to be handed a half-written ad-hoc
  query at 2am. `/api/admin/raw` exists.

So one careless `GROUP BY` on a cold table can starve the send path of
connections, and a typo can write to it. Both are fixed by the role.

The `/api/admin/growth` route header (`web/app/api/admin/growth/route.ts:13`)
already documents the failure mode this produces, and its author worked
around it by hand:

> Production Postgres runs a small pool (max 8) shared with the whole app, and
> this dashboard answers ~40 questions. Asking them one query at a time is how
> you get **timeout-zeros**: the tail queries sit in the pool queue longer than
> their own budget and silently resolve to 0, so the page renders confident
> wrong numbers.

A separate pool means the next dashboard author does not have to be that
careful to be safe.

---

## 1. What already exists (verified against the code)

### 1.1 The growth pipeline — `web/lib/analytics/growth-schema.ts`

Six tables, all behind `ensureGrowthSchema()` gated on
`schemaVersionGate("growth_events_schema_version", GROWTH_SCHEMA_VERSION)`
with `GROWTH_SCHEMA_VERSION = "2026-07-25.1"` (line 54). The gate hashes the
**version string you pass, not the DDL**, so bumping it is manual discipline.

| Table | Grain | Notes |
| --- | --- | --- |
| `growth_events` | one row per event | 25 columns. Event name column is **`event`**, not `name`/`kind`. `props JSONB`. |
| `growth_daily_active` | `(day, user_id, platform)` PK | The DAU/WAU/MAU + retention rollup. Read this, never the event log. |
| `growth_user_firsts` | `user_id` PK | 13 first-touch milestone timestamps. |
| `growth_attribution` | `anon_id` PK | Anonymous first touch (utm/referrer/landing), `stitched_at` when joined to a user. |
| `growth_user_attribution` | `user_id` PK | Post-stitch 1:1 side table. Exists because `users` has **no** utm/source columns. |
| `growth_invites` | `invite_id` PK | K-factor: created → first click → signup. |

Privacy exclusions are documented at `growth-schema.ts:39-50`: no email, name,
handle, address or phone; no IP; no exact amounts (only `fee_usd`); no
plaintext referral code (`ref_code_hash` only); no full URLs. **Keep that
invariant** — it is what makes it defensible to query this from a laptop.

### 1.2 Revenue — `web/lib/analytics/growth-revenue.ts`

`revenue_events` (`source`, `ref`, `user_id`, `gross_usd`, `fee_usd`,
`fee_bps`, `currency`, `corridor`, `platform`, `derived`, `occurred_at`),
`UNIQUE (source, ref)` so writes are idempotent. Plus additive
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS fee_usd` on `transfers`,
`tx_history` and `linq_offramps`, run under a 2s `lock_timeout`, with the
version gate stamped **only if the ALTERs landed**.

### 1.3 Ready-made analytics SQL — `web/lib/analytics/growth-queries.ts`

Eleven query constants, each written as one round trip that aggregates inside
Postgres: `SQL_D7_RETENTION`, `SQL_DN_RETENTION`, `SQL_K_FACTOR`,
`SQL_DAU_WAU_MAU`, `SQL_DAU_BY_PLATFORM`, `SQL_SIGNUP_FUNNEL`,
`SQL_ONBOARDING_DROPOFF`, `SQL_ACTIVATION`, `SQL_ACQUISITION`,
`SQL_REVENUE_BY_DAY`, `SQL_PUSH_PERFORMANCE`, plus seven runner functions.
These use `$1/$2` placeholders deliberately (comment at line 284) because the
libsql-shaped adapter numbers `?` sequentially and **cannot reuse a
parameter**.

### 1.4 Joinable per-user tables that already exist

`users`, `tx_history`, `rewards_events`, `rewards_award_ledger`,
`rewards_farming_flags`, `rewards_integrity_audit`, `redemptions`,
`savings_goals`, `transfers`, `linq_offramps`, `onramp_kyc`,
`kyc_upgrade_intents`, `travel_rule_records`, `user_bank_accounts`,
`device_token`, `roundup_queue`, `send_limit_ledger`, `mobile_sessions`,
`analytics_tx_ledger`, `analytics_user_stats`, `analytics_snapshots`,
`waitlist_signups`, `app_allowlist`.

**Join hazards, all real, all load-bearing:**

- `users.id` is `INTEGER`. But `transfers.user_id`, `linq_offramps.user_id`,
  `user_bank_accounts.user_id`, `payout_batches.user_id` and
  `waitlist_signups.handle_bound_user_id` are **`TEXT`**. Every join needs an
  explicit cast, and the cast must be on the TEXT side
  (`t.user_id = u.id::text`) so the `idx_transfers_user` index stays usable.
- `tx_history.amount` is **`TEXT`**. Count it, never sum it. USD sums come
  from `analytics_tx_ledger.amount_usd` (double) or
  `transfers.usdsui_amount` (numeric).
- `analytics_tx_ledger` joins on **`address = users.sui_address`**, not on
  `user_id`.
- All `*_at` / `*_ms` columns are **BIGINT epoch milliseconds**, not
  timestamps. Convert with `to_timestamp(col / 1000.0) AT TIME ZONE 'UTC'`.
  The single exception is `onramp_kyc.updated_at`, which is `TIMESTAMPTZ`.
- `COUNT(*)` and `NUMERIC` come back from postgres.js as **strings**.
  `Number()` them or the dashboard will concatenate totals.

---

## 2. What is missing (this is the real work)

The tables are in far better shape than the pipeline. Four gaps, in the order
they block you.

### 2.1 Nothing server-side emits growth events

`emitGrowthEvent()` in `web/lib/analytics/growth-ingest.ts:310` — the
server-side emitter, designed to be a one-liner on any money path — has
**zero call sites in the entire repo.** Everything in `growth_events` today
arrives from the three clients via `POST /api/events`.

Consequence: of the 33 names in the `GROWTH_EVENTS` union
(`web/lib/analytics/events.ts:38`), these are **never emitted by anything**:

`send_reviewed`, `cashout_started`, `cashout_completed`, `cashout_failed`,
`swap_completed`, `earn_supplied`, `perp_closed`, `handle_claimed`,
`kyc_started`, `kyc_completed`, `push_permission_granted`,
`push_permission_denied`.

So `growth_user_firsts.handle_claimed_at`, `.kyc_completed_at`,
`.first_cashout_at` and `.push_enabled_at` are **structurally always NULL**,
and `SQL_PUSH_PERFORMANCE` is structurally always empty. Every money-shaped
event — the ones you actually want per-user — is absent.

**Fix:** one `emitGrowthEvent(...)` line per money path, server-side, after the
rail believes the money moved. Server-side is the right side: it cannot be
skipped by an old client, spoofed by a new one, or lost when the app is
killed mid-flow. It is already `after()`-scheduled and never throws, so it
cannot affect a response.

### 2.2 The referral funnel is silently discarded — a live bug

There are **two different functions named `emitGrowthEvent`**:

1. `web/lib/analytics/growth-ingest.ts:310` — the real one. Zero callers.
2. `web/lib/referral-events.ts:138` — a "thin local helper", **five callers**
   (`app/r/[code]/route.ts:72`, `app/api/referral/event/route.ts:79,88`,
   `app/api/auth/exchange/referral/route.ts:102`, `lib/auth-exchange.ts:74,84`).

The wired one predates the pipeline and feature-probes
`information_schema.columns` to guess `growth_events`' shape. Its candidate
lists (`referral-events.ts:58-62`) resolve against the real table to
`event`, `user_id`, `props`, `ts` — and it inserts **exactly those four
columns**.

But `growth_events` declares `received_at BIGINT NOT NULL`, `day DATE NOT
NULL` and `platform TEXT NOT NULL`, **none with a default**
(`growth-schema.ts:82-89`).

So every referral-funnel insert violates a not-null constraint, is caught at
`referral-events.ts:180`, and logs `[growth] <name> insert skipped: …`. The
whole invite funnel — `invite_sent`, `invite_clicked`, `invite_signup`,
`invite_attribution_failed` — exists **only in Vercel console logs**, and
`SQL_K_FACTOR` reads a `growth_invites` table nothing populates from that
path either.

**Fix (pick one, do not do both):** either repoint the five call sites at the
real `growth-ingest` emitter and delete the probe, or teach the probe to
supply `received_at`/`day`/`platform`. The first is correct; the second is
smaller. Until then, treat K-factor as unmeasured, not as zero.

### 2.3 `revenue_events` is empty, and revenue-per-user is unindexed

`recordRevenue()` (`growth-revenue.ts:209`), `revenueBySource()` (line 353)
and `backfillTransferFees()` (line 295) all have **zero call sites**. The
table will be empty on every environment.

Worse, even once populated, **`revenue_events` has no index on `user_id`** —
only `UNIQUE (source, ref)`, `(occurred_at DESC)` and
`(source, occurred_at DESC)`. "Revenue from this one user" is a seq scan.

Note also that `ensureRevenueSchema()` is only reached opportunistically from
`ingestBatch` (`growth-ingest.ts:264`), so on a fresh database the
`revenue_events` table and the `fee_usd` columns do not exist until somebody
posts a client event.

**One thing you can use today:** the rewards ledger is now the best
server-side record of a perps close. `rewards_award_ledger` rows with
`trigger_kind = 'perps_close'` carry `user_id`, `digest` and `verified_usd`,
where `verified_usd` **is the 2% close fee the treasury was actually
credited** — chain-verified revenue, per user, per trade, idempotent by
`claim_key`. Until `recordRevenue` is wired, that is a real revenue feed for
one product line:

```sql
SELECT user_id,
       COUNT(*)                AS closes,
       SUM(verified_usd)       AS perp_fee_revenue_usd
  FROM rewards_award_ledger
 WHERE trigger_kind = 'perps_close'
   AND status = 'settled'
   AND settled_at >= $1
 GROUP BY user_id
 ORDER BY perp_fee_revenue_usd DESC
 LIMIT 50;
```

### 2.4 Nothing renders any of it

`/api/admin/growth` computes ~40 metrics in six round trips through a
concurrency limiter of 3 — good, careful code — but it computes **none** of
the questions in this document. It has no DAU/WAU/MAU, no retention, no
K-factor, no activation, no acquisition-by-channel and no revenue. Its
"Behavioural metrics" panel feature-detects `growth_events`, guesses the
column names from candidate lists, and renders only a day/user/count DAU
series and a top-20 event list.

The seven runner functions in `growth-queries.ts` are imported by nothing.
**Wiring existing SQL to a page is the cheapest large win available.**

> ⚠️ One trap: that route's `TS_CANDIDATES` list is
> `["created_at", "occurred_at", "ts", "event_at", "at"]` and picks the
> **first match**. It currently resolves to `ts` only because `created_at`
> does not exist on `growth_events`. If anyone adds a `created_at` column,
> the dashboard silently repoints to it. Do not add one.

---

## 3. The four questions, and what each still needs

### 3.1 Per-user activity timeline

*"Show me everything user 412 has done."*

**Have:** `growth_events (user_id, ts DESC) WHERE user_id IS NOT NULL`
(partial index, already correct for this), `tx_history (user_id, created_at
DESC)`, `rewards_events (user_id, created_at DESC)`, `rewards_award_ledger
(user_id, trigger_kind, settled_at DESC)`, `transfers (user_id, created_at
DESC)`, `linq_offramps`, `redemptions`, `mobile_sessions`.

**Need:** one UNION ALL query that interleaves those sources into a single
`(ts, source, kind, amount_usd, status, ref)` stream, `ORDER BY ts DESC LIMIT
200`. Long-format UNION ALL is the established pattern in this repo
(`DAILY_SQL`, `BREAKDOWNS_SQL`) precisely because it is one round trip.

**Also need:** the money events from §2.1. Without them the timeline shows
what the user *tapped* and what *settled*, with nothing in between — you
cannot tell an abandoned send from a failed one.

### 3.2 Cohort / retention

**Have:** `growth_daily_active` with a `(day, user_id, platform)` PK, which is
day-leading, so day-range scans are covered. `SQL_DN_RETENTION` and
`SQL_D7_RETENTION` are written and correct.

**Need:** a cohort anchor that is actually populated.
`growth_user_firsts.signup_completed_at` is filled by `deriveEvents`
(`growth-ingest.ts:691`) **only when a client posts an event**, so a user who
signed up and never reopened the app has no cohort. Prefer
`users.created_at` as the anchor and treat `growth_user_firsts` as
enrichment. Add the index in §5.

**Need:** the runner wired to a page. Nothing calls `dnRetention()`.

### 3.3 Funnel

**Have:** `SQL_SIGNUP_FUNNEL`, `SQL_ONBOARDING_DROPOFF`, `SQL_ACTIVATION`, and
`growth_user_firsts` with the right 13 columns.

**Need:** the missing emissions (§2.1). `handle_claimed`, `kyc_started`,
`kyc_completed` and the `cashout_*` family are never emitted, so the funnel
has holes exactly where the regulated, expensive steps are. `handle_claimed`
and `kyc_completed` in particular are cheap to backfill from state you
already hold — `users.talise_username IS NOT NULL` and `users.kyc_tier > 0` /
`onramp_kyc.status = 'approved'`.

**Need:** `growth_events` to be queryable by time. See §5.

### 3.4 Revenue per user

**Have:** the `revenue_events` schema, a fee schedule
(`growth-revenue.ts:161`), `SQL_REVENUE_BY_DAY`, and `fee_usd` columns on
`transfers` / `tx_history` / `linq_offramps`.

**Need:** `recordRevenue()` called from the six fee-charging paths (swap
overlay, NAVI supply, perps close, FX spread, offramp, onramp); the `user_id`
index from §5; and a decision on `derived` (a modelled fee from a bps
schedule is not the same fact as a fee we watched land, and the column exists
to keep them apart — use it).

### 3.5 Abuse signals

**Have:** `rewards_farming_flags` (per-user block + reason + actor),
`rewards_integrity_audit` (reversible, attributable clawbacks),
`rewards_award_ledger.status` with `rejected` / `expired` reasons — which is a
genuinely good abuse feed, because a farming attempt leaves a `rejected` row
with the *reason it failed*. `send_limit_ledger`. `abuse_rate_counters`.

**Missing:** `abuse_rate_counters` is keyed by an opaque `bucket TEXT` with no
`user_id` column, so "which user is getting rate-limited" is not answerable.
Rate limits live in Upstash Redis when configured
(`web/lib/rate-limit.ts:123`) and in a per-instance `Map` when not, so they
are not in Postgres at all.

**Cheapest high-value abuse view available today** — rejection reasons are
free-text but stable-prefixed:

```sql
SELECT user_id,
       COUNT(*) FILTER (WHERE status = 'rejected')  AS rejected,
       COUNT(*) FILTER (WHERE status = 'expired')   AS expired,
       COUNT(*) FILTER (WHERE status = 'settled')   AS settled,
       MIN(reason) FILTER (WHERE status = 'rejected') AS sample_reason
  FROM rewards_award_ledger
 WHERE created_at >= $1
 GROUP BY user_id
HAVING COUNT(*) FILTER (WHERE status = 'rejected') > 5
 ORDER BY rejected DESC
 LIMIT 50;
```

A user with many `shape mismatch` or `digest already claimed` rejections is
probing the rewards engine. That is the signal you want and it is one query.

---

## 4. Exact local setup

### Step 1 — create the read-only role (run once, as the DB owner)

```sql
-- A role that CANNOT write, so "read-only dashboard" is a permission
-- rather than a code-review convention.
CREATE ROLE talise_analytics LOGIN PASSWORD '<generate-32-random-bytes>';

GRANT CONNECT ON DATABASE <dbname> TO talise_analytics;
GRANT USAGE   ON SCHEMA public     TO talise_analytics;
GRANT SELECT  ON ALL TABLES IN SCHEMA public TO talise_analytics;

-- Tables created later (every ensure*Schema() adds some) must be readable
-- too, or the dashboard breaks on the next feature.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO talise_analytics;

-- Server-side budgets. Unlike the client-side Promise.race wrappers in
-- lib/analytics.ts and the admin routes, these actually stop the query and
-- release the connection.
ALTER ROLE talise_analytics SET statement_timeout = '15s';
ALTER ROLE talise_analytics SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE talise_analytics SET lock_timeout = '2s';

-- Never let the dashboard outvote real traffic for CPU or I/O.
ALTER ROLE talise_analytics SET synchronous_commit = 'off';

-- Hard ceiling on how much of the primary's connection budget it can take.
ALTER ROLE talise_analytics CONNECTION LIMIT 4;
```

Explicitly **do not** grant `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, or any
privilege on sequences. If a dashboard query needs to write, the dashboard is
wrong.

### Step 2 — point it at a replica if you have one

If the provider offers a read replica (Supabase Read Replicas, Neon read-only
compute), put `DATABASE_URL_ANALYTICS` on the **replica** endpoint, not the
primary. Then heavy per-user scans cannot touch the primary at all and §5's
indexes matter less. Replica lag is irrelevant for a growth dashboard.

### Step 3 — env vars

In `web/.env.local` **only**. Never in Vercel — see §6.

```bash
# Read-only analytics role, ideally on a read replica.
DATABASE_URL_ANALYTICS="postgres://talise_analytics:...@host:5432/db?sslmode=require"

# Admin gate. Setting this ALSO disables dev-open mode (lib/admin-auth.ts:42),
# so set it even locally once more than one person can reach the machine.
ADMIN_TOKEN="<32+ random chars>"

# Optional: extra admin emails beyond the hardcoded ADMIN_EMAILS in lib/admin.ts.
ADMIN_EXTRA_EMAILS="someone@example.com"
```

Note the pooler caveat from `web/DEPLOY.md`: if the URL is a PgBouncer
transaction-mode pooler (Supabase port `6543`, or `?pgbouncer=true`), prepared
statements must be off. `web/lib/db.ts:152-157` auto-detects that for
`DATABASE_URL`; the analytics pool must replicate the check.

### Step 4 — the analytics pool

`web/lib/db.ts` reads `DATABASE_URL` only, and it is off-limits to change. So
the read-only pool is a **new, separate module — and it belongs in
`web/app/admin/_lib/`**, which is untracked. That is not a workaround, it is
the right place: a pool that only the local-only dashboard may use should be
physically incapable of shipping.

Requirements:

- `max: 2`. The dashboard's job is to be invisible in the pool. With the six
  round trips of `/api/admin/growth` already limited to 3 concurrent, 2 is
  enough and leaves a hard bound.
- `idle_timeout: 5`, `max_lifetime: 60`. Short, because a laptop dashboard is
  bursty and idle 99% of the time, and because stale pooled sockets are what
  wedged `/admin` on "Loading…" before (`web/lib/db.ts:164-169`).
- `connect_timeout: 10`.
- The **`globalThis` singleton pattern** from `web/lib/db.ts:117-118,195`.
  Next dev-mode HMR re-evaluates modules on every save; without the singleton
  you leak a pool per edit and exhaust `CONNECTION LIMIT 4` in a few minutes.
- The same `types.bigint → Number` parser as `web/lib/db.ts:185-192`, or every
  millisecond timestamp arrives as a `BigInt` and the date maths breaks.
- Fall back to `DATABASE_URL` when `DATABASE_URL_ANALYTICS` is unset, so a
  fresh clone still works.

### Step 5 — migrate before you switch, and never after

`ensureSchema()` runs ~114 DDL statements. Under the read-only role they all
fail.

This is mostly harmless by construction: the version-gate fast path is a
single `SELECT` against `global_kv`, so when the schema is current
`doEnsureSchema()` returns early and attempts no DDL. Admin routes also call
`await ensureSchema().catch(() => {})`.

But the ordering rule is absolute:

1. Deploy / run the app under the **read-write** `DATABASE_URL` and let it
   stamp every `*_schema_version` key.
2. *Then* open the dashboard on the read-only role.

Two consequences to keep in mind:

- Do not call `ensureGrowthSchema()` or `ensureRewardsIntegritySchema()` from
  an admin page. Unlike `ensureSchema()`, those **re-throw** on failure
  (`integrity.ts:118`). Feature-detect instead — `/api/admin/growth` already
  demonstrates the `information_schema` probe pattern.
- `ensureRevenueSchema()` must have run at least once under the read-write
  role or `revenue_events` will not exist.

### Step 6 — run it

```bash
cd web && pnpm dev          # then open http://localhost:3000/admin
```

Authentication resolves in `web/lib/admin-auth.ts:81` by:
`dev-open` (only when **not** on Vercel and `ADMIN_TOKEN` is unset) → the
`talise_admin` httpOnly cookie set by `/admin/login` (12h) → an allowlisted
Google session (`ADMIN_EMAILS` / `ADMIN_HANDLES` / `ADMIN_EXTRA_EMAILS` in
`web/lib/admin.ts`).

`process.env.VERCEL` is a hard kill-switch on dev-open
(`web/lib/admin-auth.ts:42`), so it can never engage on a deployment,
including previews. Do not weaken that check.

### Step 7 — connection hygiene in every query you add

- **One round trip per panel.** Fold N metrics into one query: scalar
  subqueries in a single `SELECT` for scalars, `UNION ALL` with a tag column
  for series and breakdowns. `/api/admin/growth` is the reference
  implementation.
- **Cap concurrency.** Reuse the `runLimited(thunks, 3)` helper
  (`web/app/api/admin/growth/route.ts:136`).
- **Always `LIMIT`.** Aggregate in Postgres; never pull rows to count them in
  JS.
- **Paginate and return `{ rows, total, page, pageSize }`** per `CONTRACT.md`.
- **Never open a transaction.** `db().batch()` wraps everything in
  `sql.begin()` (`web/lib/db.ts:282`) and holds a connection for the whole
  batch. A read-only dashboard has no reason to.
- **Keep the client-side timeout too.** The role's `statement_timeout` stops
  the query; the `Promise.race` stops a wedged *socket*. They cover different
  failures, so keep both, and keep the per-panel fallback so one slow query
  degrades one card instead of the page.

---

## 5. Schema and index additions

All are `CONCURRENTLY` — these tables are on the money path and a plain
`CREATE INDEX` takes an `ACCESS EXCLUSIVE` lock. `CONCURRENTLY` cannot run
inside a transaction, so run each statement on its own, as the owner, **not**
through `db().batch()`.

```sql
-- 5.1 growth_events has NO index supporting a bare `ts` range scan. Both the
-- live /api/admin/growth probe and SQL_SIGNUP_FUNNEL / SQL_PUSH_PERFORMANCE
-- filter `WHERE ts >= $1 AND ts < $2`. Today those are seq scans, and this is
-- the table that grows without bound.
CREATE INDEX CONCURRENTLY IF NOT EXISTS growth_events_ts_idx
  ON growth_events (ts DESC);

-- 5.2 Per-user revenue is currently a seq scan: revenue_events has
-- UNIQUE(source, ref), (occurred_at DESC) and (source, occurred_at DESC),
-- but nothing on user_id.
CREATE INDEX CONCURRENTLY IF NOT EXISTS revenue_events_user_idx
  ON revenue_events (user_id, occurred_at DESC)
  WHERE user_id IS NOT NULL;

-- 5.3 Cohort anchors. growth_user_firsts has a user_id PK and no secondary
-- indexes, so every cohort/funnel query scans it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS growth_user_firsts_signup_idx
  ON growth_user_firsts (signup_completed_at)
  WHERE signup_completed_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS growth_user_firsts_first_send_idx
  ON growth_user_firsts (first_send_at)
  WHERE first_send_at IS NOT NULL;

-- 5.4 Rewards abuse feed (§3.5) filters on status + created_at across ALL
-- users. The existing indexes are all user_id-leading, so a global sweep
-- can't use them.
CREATE INDEX CONCURRENTLY IF NOT EXISTS rewards_award_ledger_status_created_idx
  ON rewards_award_ledger (status, created_at DESC);

-- 5.5 Nothing needed for rewards_events: lib/db.ts:537-541 already creates
-- (user_id), (created_at DESC) and (user_id, created_at DESC). Both the
-- per-user timeline and the global feed are covered. Listed so nobody adds a
-- fourth.

-- 5.6 Attribution by campaign. growth_user_attribution is indexed on
-- (source) only; acquisition breakdowns group by source+medium+campaign.
CREATE INDEX CONCURRENTLY IF NOT EXISTS growth_user_attribution_campaign_idx
  ON growth_user_attribution (source, medium, campaign);
```

**Do not add** a `created_at` column to `growth_events` — see the trap in
§2.4.

**Where the DDL should live.** Not in `web/lib/db.ts` (owned elsewhere) and not
in `web/app/admin/**` (untracked, so it would never reach production). Add the
`CREATE INDEX` statements to the `DDL` array of the module that owns each
table — `web/lib/analytics/growth-schema.ts` for `growth_events` /
`growth_user_firsts` / `growth_user_attribution`,
`web/lib/analytics/growth-revenue.ts` for `revenue_events`,
`web/lib/rewards/integrity.ts` for `rewards_award_ledger` — and **bump that
module's schema version string**, or the gate short-circuits and the index is
never created. Note the existing `ensure*` helpers use plain
`CREATE INDEX IF NOT EXISTS`; for these tables at production size, run the
`CONCURRENTLY` form by hand first so the gated statement is a no-op.

### Schema additions worth considering (not just indexes)

- **`abuse_rate_counters` has no `user_id`.** Adding a nullable `user_id
  INTEGER` (and an index) is the only way to answer "who is hitting limits"
  from Postgres. Owned by `web/lib/abuse/**`.
- **No table records a perps close server-side.** In the sponsored path
  `/api/markets/close` returns unsigned bytes and never learns the digest;
  `getTrades`/`addTrade` stash a JSON blob in `global_kv` keyed
  `waterx_trades:<userId>`, capped at 100 entries, which is unqueryable. The
  `rewards_award_ledger` rows described in §2.3 are currently the only
  relational record. A proper `perp_trades` table would fix both monitoring
  and revenue.
- **`users` has no acquisition columns** by design; that is what
  `growth_user_attribution` is for. Do not add utm columns to `users` — it
  would fork the source of truth.

---

## 6. What NOT to do

1. **Never expose `/admin` publicly.** `web/app/admin/` is untracked on
   purpose. Do not `git add -f` it, do not add it to a deploy allowlist, do
   not "temporarily" ship it behind a token. `ADMIN_TOKEN` is a lock on a
   door that should not exist on the internet.
2. **Never put `DATABASE_URL_ANALYTICS` in Vercel.** It has no server-side
   consumer. A production credential with no production consumer is pure
   attack surface.
3. **Never run analytics on the request path of the `max: 8` app pool.** That
   is the documented cause of timeout-zeros — a dashboard that renders
   confident wrong numbers, which is strictly worse than one that errors.
4. **Never let an admin query write.** Not a backfill, not a "quick fix", not
   a `CREATE INDEX`. Migrations run through the owning module's
   `ensure*Schema()` under the read-write role, where they are version-gated
   and reviewable in git. The read-only role makes this structural; keep it
   that way even if it is briefly inconvenient.
5. **Never `SELECT email`, `name`, `picture`, `salt`, or a bank number into a
   dashboard payload.** `TOP_USERS_SQL` deliberately omits `email`
   (`web/app/api/admin/growth/route.ts:431-434`). Bank numbers are AES-256-GCM
   encrypted at rest and must stay that way — a dashboard is not a reason to
   decrypt. Identify users by `id` and `talise_username`.
6. **Never widen the `growth_events` privacy envelope** to make a query
   easier. No IP, no device id, no exact amounts (use `amount_band`), no
   plaintext referral codes, no full URLs. Those exclusions are what make it
   acceptable to pull this data onto a laptop.
7. **Never interpolate a user-supplied identifier into SQL.** `/api/admin/raw`
   and any sort/filter parameter must whitelist against a fixed set of column
   names. Parameterise values with `?` (rewritten to `$n` by
   `web/lib/db.ts:204`), and remember a `?` **cannot be reused** — pass the
   value once per placeholder, or switch the whole query to `$n` as
   `growth-queries.ts` does.
8. **Never read a snapshot table as truth.** `user_balance_snapshot`,
   `user_activity_snapshot` and `user_insights_snapshot` are **DISPLAY-ONLY**
   (`web/lib/db.ts:909-913`). They are stale by construction. For a real
   figure go to `analytics_tx_ledger`, `transfers`, or the chain.
9. **Never treat an empty result as a zero.** `web/lib/activity.ts` refuses to
   aggregate a partial read for this exact reason. An unwired pipeline (§2), a
   swallowed insert (§2.2), a client-side timeout fallback and a genuine zero
   are four different facts that all render as `0`. Label provenance in the
   UI — `/admin/growth` already does this with its `pending pipeline` / `live`
   pill and its `SnapshotBasisLegend`.
