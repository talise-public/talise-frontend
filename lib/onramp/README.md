# On-ramp + KYC scaffold (provider-agnostic, dormant)

Additive "Add money" (fiat on-ramp) + tiered KYC scaffold. **Safe by
construction**: feature-flagged, no live secrets, and it touches **no**
send / balance / limit / wallet code path. It ships *alongside* the existing
Stripe-based on-ramp (`app/api/onramp/session` + `app/api/onramp/webhook`) —
those are untouched and remain the current live path.

## Env vars

| Var | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_ONRAMP_ENABLED` | client + server | Master feature flag. `"true"` enables the modal and the `/api/onramp/v2/*` routes. Anything else = fully dormant. |
| `ONRAMP_PROVIDER` | server | `bridge` (default) or `transak`. Selects the active adapter. |
| `BRIDGE_API_KEY` | server | Bridge API key. **Unset → Bridge runs as a stub** (typed mock data, no network, no money). |
| `BRIDGE_WEBHOOK_SECRET` | server | HMAC secret for verifying Bridge webhooks. |
| `TRANSAK_API_KEY` | server | Transak API key. **Unset → Transak runs as a stub.** |
| `TRANSAK_API_SECRET` | server | Transak webhook/JWT secret. |

All are documented in `web/.env.example`. No real keys are committed.

## Providers

- **Bridge (default).** Bridge (a Stripe company) issues USDsui, the "Sui
  Dollar." So this adapter delivers **USDSUI directly** on Sui — no swap.
  Supports bank + card. `lib/onramp/bridge.ts`.
- **Transak (fallback).** Card-supporting aggregator. Delivers **USDC on
  Sui**, then a **swap-to-USDsui** step is required (`requiresSwapToUsdsui:
  true`); the existing AutoConvertBanner already sweeps inbound USDC → USDsui.
  `lib/onramp/transak.ts`.

Both implement the `OnrampProvider` interface (`lib/onramp/types.ts`):

```
getRequirements({ amountCents, country, currentTier }) -> { requiredTier, missingFields[], satisfied }
createOrUpdateCustomer(profile) -> { providerCustomerId, status, dailyLimitCents?, monthlyLimitCents? }
createOnrampSession({ providerCustomerId, amountCents, destinationAddress, deliverAsset }) -> { widgetUrl? | clientSecret?, requiresSwapToUsdsui }
verifyWebhook(rawBody, headers) -> OnrampWebhookEvent
```

`lib/onramp/index.ts` selects the provider by `ONRAMP_PROVIDER` (default
`bridge`) via `getOnrampProvider()`.

## KYC tiers (dynamic per country)

The ladder + amount/country → tier mapping lives in
`lib/onramp/requirements.ts` (scaffold thresholds, **not** compliance-
reviewed):

| Tier | Fields | Amount (scaffold) |
|---|---|---|
| `none` | — | $0 |
| `lite` | firstName, lastName, email, mobile, country, address{line1, city, region, postalCode} — **no ID** | < $100 |
| `standard` | lite + government ID + selfie/liveness + purposeOfUsage (+ **SSN if US**) | $100–$1,000 |
| `enhanced` | standard + proofOfAddress + sourceOfFunds | > $1,000 |

This on-ramp tier is stored in the **new** `onramp_kyc` table and is
**separate** from `users.kyc_tier` (the integer 0–3 send-gate in
`lib/kyc.ts`), which stays authoritative for sending. The on-ramp table is
display / compliance-state only.

## API routes (`app/api/onramp/v2/*`)

Namespaced under `/v2` so they sit alongside the existing Stripe routes
without modifying them. All require auth; the first two require the feature
flag.

- `POST /api/onramp/v2/requirements` — `{ amountCents, country }` → required
  tier + missing fields (quote-gated KYC).
- `POST /api/onramp/v2/session` — `{ amountCents, provider?, profile? }` →
  stub `widgetUrl`. Destination is **locked** to the signed-in user's Sui
  address.
- `POST /api/onramp/v2/kyc-webhook?provider=bridge|transak` — verify + parse
  a provider webhook, write through to `onramp_kyc`. **DB write is guarded**:
  if the migration isn't applied the write no-ops gracefully (logs a warning,
  never throws).

## Modal

`components/app/AddMoneyModal.tsx` — client component on the `Sheet` surface.
Amount → requirements → renders only the fields the amount requires (lite
inline; ID prompt only for standard+) → provider widget placeholder. Prefills
name/email/country from the `/api/me` shape. **Renders `null` unless
`NEXT_PUBLIC_ONRAMP_ENABLED === "true"`.** It is exported but deliberately
**not** mounted in primary nav.

## What is stubbed vs real

- **Stubbed:** all provider network calls. With no API key, adapters return
  deterministic typed mocks (fake `widgetUrl`, derived customer ids,
  pending/approved statuses). Webhook signature verification is a placeholder
  HMAC pending confirmation of each provider's exact scheme. Real call sites
  are marked `// TODO(live):`.
- **Real:** the interface, the env-driven selector, the requirements/tier
  engine, the route plumbing + auth, the guarded `onramp_kyc` persistence,
  and the modal UI.

## Migration

`web/migrations/2026-06-05-onramp-kyc.sql` — creates `onramp_kyc`. **NOT
applied.** Talise manages schema in-code via `ensureSchema()` in `lib/db.ts`;
to go live, fold the DDL into that array (preferred) **or** run the file once
by hand against `DATABASE_URL`.

## Go-live checklist

1. **Apply the migration** — fold `2026-06-05-onramp-kyc.sql` into
   `doEnsureSchema()` in `lib/db.ts` (or run it once against the DB).
2. **Set secrets** (Vercel prod): `ONRAMP_PROVIDER`, `BRIDGE_API_KEY`,
   `BRIDGE_WEBHOOK_SECRET` (and/or `TRANSAK_API_KEY`, `TRANSAK_API_SECRET`).
3. **Implement the `// TODO(live):` calls** in `bridge.ts` / `transak.ts`
   (createOrUpdateCustomer, createOnrampSession, real webhook verification).
4. **Wire the widget** — replace the modal's placeholder with the real hosted
   URL redirect / embedded SDK mount.
5. **Confirm Bridge Sui + card GA** — verify Bridge can mint/deliver USDsui to
   a Sui address and that card funding is live for your jurisdictions; until
   then, set `ONRAMP_PROVIDER=transak` (USDC + swap) as the fallback.
6. **Review the tier thresholds** in `requirements.ts` with compliance per
   jurisdiction before enabling for real money.
7. **Flip `NEXT_PUBLIC_ONRAMP_ENABLED=true`** and mount `AddMoneyModal` from
   the desired surface.
