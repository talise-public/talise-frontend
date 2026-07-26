# Growth analytics — what is wired, and how to read it

The pipeline (`growth-schema.ts`, `growth-ingest.ts`, `growth-queries.ts`,
`growth-revenue.ts`) was fully built and connected to nothing:
`emitGrowthEvent()` had zero call sites, `recordRevenue()` had zero call sites,
and all eleven dashboard queries were imported by nothing. This document is the
map of what now connects to what.

Two different functions are called `emitGrowthEvent`. This one is
`lib/analytics/growth-ingest.ts` (the full taxonomy). The other is
`lib/referral-events.ts` (referral funnel only, already wired). They are
unrelated; don't cross the wires.

---

## 1. Reading the numbers

Everything is behind one admin-gated route. `web/app/admin/**` is untracked by
policy so the ops dashboard never deploys — the *read* lives under
`app/api/admin/`, which is tracked, gated by `requireAdminApi()`
(`x-admin-token` header, `talise_admin` cookie, or an allowlisted signed-in
identity) and hard-closed on every Vercel deployment.

```bash
# Local (dev-open when ADMIN_TOKEN is unset):
curl -s 'http://localhost:3000/api/admin/growth/metrics?days=30' | jq

# Production / preview:
curl -s -H "x-admin-token: $ADMIN_TOKEN" \
  'https://app.talise.io/api/admin/growth/metrics?days=90' | jq
```

One JSON object, one key per metric, every one of the eleven `growth-queries.ts`
SQL definitions:

| key | query | answers |
| --- | --- | --- |
| `dauWauMau` | `SQL_DAU_WAU_MAU` | DAU / WAU / MAU |
| `dauByPlatform` | `SQL_DAU_BY_PLATFORM` | the iOS / Android / web split by day |
| `retentionD1/D7/D30` | `SQL_DN_RETENTION` | day-N return by signup cohort |
| `kFactor` | `SQL_K_FACTOR` | K, invites/inviter, click-through, click→signup |
| `signupFunnel` | `SQL_SIGNUP_FUNNEL` | started → authed → account → onboarded |
| `onboardingDropoff` | `SQL_ONBOARDING_DROPOFF` | which onboarding step loses people |
| `activation` | `SQL_ACTIVATION` | signup → funded → first send, with medians |
| `acquisition` | `SQL_ACQUISITION` | signups + activation by channel |
| `revenueByDay` | `SQL_REVENUE_BY_DAY` | fee revenue per day per source, measured vs derived |
| `revenueBySource` | `revenueBySource()` | fee revenue per source over the window |
| `pushPerformance` | `SQL_PUSH_PERFORMANCE` | push reachability + notification CTR |

`SQL_D7_RETENTION` is the copy-pasteable psql form of the D7 case;
`retentionD7` runs the parameterised `SQL_DN_RETENTION` with N=7, same
definition.

Pool discipline: twelve queries, concurrency 3, a 20 s per-query budget (this
schema sets no `statement_timeout`, so the cap is client-side). A query that
overruns returns `[]` **and names itself in `partial`** — so an empty panel is
distinguishable from a real zero. `partial: []` means every number is real.

### Backfill (run once, then whenever you want the fee walk continued)

```bash
curl -s -X POST -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"action":"backfill"}' \
  'https://app.talise.io/api/admin/growth/metrics' | jq
```

Idempotent and set-once. Repeat until `transferFees` returns `0` to finish
walking settled `transfers` into `revenue_events`.

---

## 2. Events now emitted server-side

All of these go through `lib/analytics/emit.ts`. Every helper there is
synchronous, returns `void`, wraps its own body, and schedules its writes with
`after()` — so **no emit can fail, throw into, or delay a money path**, and none
of them holds a connection from the `max: 8` pool while a user waits.

| event | emitted from | when |
| --- | --- | --- |
| `handle_claimed` | `api/username/claim` | every claim success path (fresh mint, already-owned subname, name-targets-caller) |
| `kyc_started` | `api/kyc` (POST), `api/kyc/bridge/start` | the upgrade intent row / the hosted link exists |
| `kyc_completed` | `api/kyc/webhook`, `api/kyc/bridge/status`, `api/kyc/bridge/start` | provider-signed approval, or a Bridge status read returning `approved` |
| `push_permission_granted` | `api/devices/register` | a push token was registered — the OS only issues one after the user accepts |
| `deposit_started` | `api/onramp/v2/session` | funding handles (virtual account / widget) handed back |
| `send_completed` | `api/zk/sponsor-execute`, `api/send/gasless-submit`, `api/send/gasless-confirm` | digest confirmed and not aborted, `meta.kind === "send"` |
| `earn_supplied` | `api/zk/sponsor-execute` | digest confirmed, `meta.kind === "invest"` |
| `swap_completed` | `api/zk/sponsor-execute` | digest confirmed, `meta.kind === "swap"` |
| `perp_closed` | `api/markets/close` | close settled (`mode === "executed"`) |
| `cashout_started` | `api/offramp/linq/create`, `api/offramp/request` | a real order/request row exists (not on an idempotent replay) |
| `cashout_completed` / `cashout_failed` | `api/offramp/linq/webhook`, `api/offramp/bridge/webhook` | a fresh, applied, terminal provider event |
| `funded` + `deposit_completed` | `api/cheques/[id]/claim/release` | escrow released to the claimer — the one funding path the server observes directly |
| `funded` | derived in `growth-ingest.ts` → `deriveEvents()` | earliest `analytics_tx_ledger` row with `direction='received'` for the user's address |

### Why `funded` is derived, not emitted from a route

There is no server-side credit anywhere on the funding path. A Bridge/card
purchase mints straight to the user's **own** Sui address, and a friend paying
them is an ordinary inbound transfer, so no route ever observes "money in" — the
on-ramp session route says so explicitly. The on-chain ledger is the observation,
and it covers every funding source at once instead of one provider.

The probe is its own guarded statement rather than a subquery in the existing
derivation SELECT, because `analytics_tx_ledger` is created by the indexer's
schema pass: on a database that has never run an indexer batch, folding it in
would take down the `signup_completed` and `first_send` derivations too. It only
runs while the milestone is unstamped, at most once per user per warm process,
post-response.

### `FIRST_COLUMNS` gained two mappings

`send_completed → first_send_at` and `deposit_completed → funded_at`. A money
path knows it completed a send; it does not know (without a query) whether that
was the user's first. Since `upsertFirsts` writes
`LEAST(COALESCE(existing, new), new)`, the earliest occurrence wins the column
forever and every later one is a no-op — so the milestone is exact without the
emitter knowing, and without writing N rows literally named `first_send` for one
user.

### The four structurally-NULL columns

`handle_claimed_at`, `kyc_completed_at`, `first_cashout_at` and `push_enabled_at`
had no emitter at all and were therefore always NULL. They are now filled
forward by the table above, and backward by the backfill below.

---

## 3. `revenue_events`: measured vs derived

`derived` is a real column and the dashboard reports it separately. Nothing is
blended.

| source | measured? | basis |
| --- | --- | --- |
| `perp_close` | **MEASURED** (`derived: false`) | `buildCloseTx` computes the 2% close fee from the position's on-chain collateral and appends it to that PTB as a USDsui transfer to the treasury. Nothing client-supplied. Recorded only when `mode === "executed"` (a real digest exists). |
| `earn_supply` | derived | `FEE_SCHEDULE.earnSupplyBps` (1%) × the principal. The schedule is exact — the server built the PTB that took `principal × 1%` — but the *principal* is the client's asserted `meta.amountUsd`, clamped to $10k (the same ceiling the rewards engine applies to the same field). Only for venues that charge it (`navi`, `scallop`); DeepBook margin supply takes no treasury fee. |
| `fx_spread` | derived | `deriveTransferFeeUsd()` × settled `transfers`, using the corridor's registered `spreadBps` from row metadata or the conservative 35 bps tier floor. Driven by the backfill. |

`ref` is UNIQUE per `(source, ref)`, so every write is idempotent and a retried
webhook or a re-run backfill cannot double-count. Digests appear there because
that is the table's documented idempotency key — they are **never** written to
`growth_events`.

### Backfilled milestones (`growth-backfill.ts`)

One statement per column, set-at-a-time, `LEAST(COALESCE(...))` so it is
idempotent and can never move a milestone later.

| column | derived from | exactness |
| --- | --- | --- |
| `signup_completed_at` | `users.created_at` | exact (ground truth). The highest-value one: every cohort/activation denominator keys off it. |
| `first_send_at` | `MIN(rewards_events.created_at)` where `kind='send_earn'` | exact |
| `funded_at` | `MIN(analytics_tx_ledger.ts)` where `direction='received'` | exact for indexed addresses; a never-indexed address stays NULL rather than guessing |
| `first_cashout_at` | `MIN(offramp_attempts.updated_at)` where `state='settled'` | exact |
| `kyc_completed_at` | `MIN(kyc_upgrade_intents.created_at)` where `ekyc_status='approved'` | **lower bound.** The intent table overwrites `ekyc_status` in place, so the verdict has no timestamp. Fine for counting verified users and ordering a cohort; do **not** quote it as verification latency. |
| `push_enabled_at` | `MIN(device_token.updated_at)` | **upper bound.** No `created_at` on that table, so a re-registered token reads later than the original grant. Fine for reachability. |

`handle_claimed_at` is deliberately **not** backfilled: `users.talise_username`
carries no timestamp and the authoritative claim time is the SuiNS mint's
on-chain stamp, which Postgres never recorded. Inventing one would put a fake
number in a column a dashboard reads as fact.

---

## 4. Deliberately NOT wired, and why

- **Swap revenue.** The 1% fee is taken *natively* by the Cetus aggregator's
  overlay inside the PTB, so the server never observes the charged amount after
  confirmation. The fee is also **0 bps for a stablecoin source**, so deriving
  1% from an asserted output would silently over-count every fee-free
  USDC→USDsui swap; deriving it from `analytics_tx_ledger` (`direction='swap'`)
  would additionally count the user's unrelated on-chain DEX activity. The
  `swap_completed` event is wired; the fee is not. Closing this honestly needs
  the measured treasury credit read back off chain (the shape the rewards engine
  already resolves), which is a money-path change, not an emit.

- **Sponsored perp closes.** `/api/markets/close` returns unsigned bytes in the
  sponsored path: the position is not yet closed, there is no digest, and no
  natural idempotency key. Booking a fee there would record revenue for a trade
  that may never land. Needs the client to report the close back after signing.

- **`/api/tx/record`.** A client-driven bookkeeping mirror that fires *in
  addition to* the execution rails for the same transaction. Emitting
  `send_completed` there would double-count every send. The three execution
  rails are the confirmation points.

- **`deposit_completed` / `deposit_failed` from a provider webhook.** The Stripe
  on-ramp webhook logs only and touches no state; Bridge on-ramp credits by
  minting on chain. Neither is a credit (or failure) event we can key a user to.
  Covered by the ledger-derived `funded` instead.

- **`send_failed` / `deposit_failed` / `cashout_failed` on the client side, and
  every client-side funnel event** (`app_open`, `screen_view`, `signup_started`,
  `onboarding_step`, `invite_sent`, `first_touch`, `notification_opened`, …).
  Those belong to the three clients via `POST /api/events`; this pass wired the
  *server* half only. `app_open` in particular is the substrate for DAU and
  retention — if `dauWauMau` reads zero, the clients are not posting it, not a
  problem with this route.

- **Cron.** `backfillUserFirsts()` and `backfillTransferFees()` are explicit
  admin actions against a shared pool, deliberately not scheduled and never
  triggered by a user action.

---

## 5. Privacy invariants held

No email, name, handle, Sui address, phone, bank detail, device id, token, IP or
full URL reaches `growth_events`. Amounts are banded through `amountBand()`
(never exact); `fee_usd` is exact because that is Talise's revenue, not the
user's balance. Provider references and tx digests appear only in
`revenue_events.ref`, as its documented idempotency key. The helper signatures in
`emit.ts` are the enforcement: there is no parameter into which a route author
could put an address or a digest-bearing behavioural field.
