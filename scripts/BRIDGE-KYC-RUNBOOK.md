# Bridge.xyz KYC + USD Cash-Out — Local Runbook

A step-by-step manual for exercising Talise's Bridge.xyz KYC + USD cash-out
flow against a **local** dev server. Drives three endpoints:

1. `POST /api/kyc/bridge/start` — mint hosted Bridge KYC + ToS links.
2. `GET /api/kyc/bridge/status` — poll Bridge for fresh status.
3. `POST /api/offramp/bridge/cashout-address` — get the persistent Sui address
   to send USDC to for a USD bank payout.

---

## ⚠️ THIS HITS PRODUCTION BRIDGE — REAL MONEY

Because `BRIDGE_API_BASE` is **unset**, the backend talks to **PRODUCTION**
Bridge (`api.bridge.xyz`), not a sandbox. That means:

- The KYC link is a **REAL Persona identity flow** — it captures a real
  government ID and selfie. Use an identity you actually control.
- The cash-out is a **REAL USDC → USD bank payout**. USDC you send to the
  returned Sui address will be converted and **wired to the bank account** you
  provide.

**Test only with a real account you control and a TINY amount ($1).**

---

## Prerequisites (already configured in `.env.local`)

| Var | Value | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_ONRAMP_ENABLED` | `true` | Enables the ramp surfaces. |
| `USD_WITHDRAWAL_OPEN` | `true` | Opens the cash-out allowlist gate. Without it, the cash-out endpoint returns `403 USD_WITHDRAWAL_CLOSED`. |
| `BRIDGE_API_KEY` | _(set)_ | Bridge API credential. |
| `BRIDGE_API_BASE` | **unset** | Leaving it unset means PRODUCTION Bridge (`api.bridge.xyz`). |

After editing `.env.local`, **restart `npm run dev`** so the new values reload:

```bash
npm run dev
```

---

## Authentication

These routes authenticate via `lib/mobile-sessions.ts` →
`readEntryIdFromRequest`, which accepts **either**:

- a web session **cookie**, OR
- an `Authorization: Bearer <token>` header.

This runbook uses the **Bearer header**. The `<token>` is the **signed mobile
bearer** returned by `issueMobileBearer()` — i.e. the exact token the iOS app
stores after sign-in. Grab a live one (e.g. from the iOS Keychain / a logged
network request from the app) and export it:

```bash
export TALISE_AUTH="<signed-bearer-token>"
```

All requests below send: `Authorization: Bearer $TALISE_AUTH`.

---

## Flow — curl

### Step 1 — Start KYC + ToS

```bash
curl -s -X POST http://localhost:3000/api/kyc/bridge/start \
  -H "Authorization: Bearer $TALISE_AUTH" \
  -H "Content-Type: application/json" | jq
```

Response:

```json
{
  "provider": "bridge",
  "status": "unverified",
  "kycUrl": "https://...persona...",
  "tosUrl": "https://...bridge.../tos",
  "kycLinkId": "...",
  "customerId": "..."
}
```

Open **both** `kycUrl` (identity) and `tosUrl` (terms) in a browser and
complete them.

### Step 2 — Poll status

```bash
curl -s http://localhost:3000/api/kyc/bridge/status \
  -H "Authorization: Bearer $TALISE_AUTH" | jq
```

Response:

```json
{
  "started": true,
  "status": "pending",
  "kycStatus": "under_review",
  "tosStatus": "approved",
  "customerId": "..."
}
```

Re-run every ~10s until `status` is `approved`. `status` is one of
`unverified | pending | approved | rejected | expired`.

### Step 3 — Cash-out address (US ACH)

Only after `status` is `approved`:

```bash
curl -s -X POST http://localhost:3000/api/offramp/bridge/cashout-address \
  -H "Authorization: Bearer $TALISE_AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "rail": "ach",
    "currency": "usd",
    "accountOwnerName": "Jane Doe",
    "accountNumber": "000123456789",
    "routingNumber": "021000021",
    "checkingOrSavings": "checking",
    "street": "123 Main St",
    "city": "New York",
    "state": "NY",
    "postalCode": "10001",
    "country": "USA"
  }' | jq
```

Response:

```json
{
  "address": "0x<sui-address>",
  "currency": "usd",
  "destinationPaymentRail": "ach",
  "note": "..."
}
```

Send a **small** USDC amount (e.g. $1) to the returned `address` on Sui. Bridge
converts USDC → USD and wires it to the bank account. Watch progress in
**Bridge Dashboard → Transfers**.

Possible error responses:

- `409 KYC_NOT_APPROVED` — KYC isn't `approved` yet. Finish KYC + ToS and wait.
- `403 USD_WITHDRAWAL_CLOSED` — cash-out gate is closed. Set
  `USD_WITHDRAWAL_OPEN=true` in `.env.local`, restart `npm run dev`, retry.

---

## Flow — one-shot script

The harness does all three steps (start → poll → cash-out) automatically:

```bash
TALISE_AUTH="$TALISE_AUTH" \
TEST_ACCOUNT_OWNER="Jane Doe" \
TEST_ACCOUNT_NUMBER="000123456789" \
TEST_ROUTING_NUMBER="021000021" \
TEST_STREET="123 Main St" \
TEST_CITY="New York" \
TEST_STATE="NY" \
TEST_POSTAL="10001" \
node scripts/bridge-kyc-roundtrip.mjs
```

Optional env: `BASE_URL` (default `http://localhost:3000`), `POLL_SECONDS`
(default 10), `POLL_MINUTES` (default 15), `TEST_CHECKING_OR_SAVINGS`
(default `checking`).

The script prints the `kycUrl`/`tosUrl` for you to open, polls until approved
(or exits non-zero on timeout / rejected / expired), then prints the Sui
cash-out address and a bank summary, and tells you to send the test USDC.
It also prints actionable messages for `409 KYC_NOT_APPROVED` and
`403 USD_WITHDRAWAL_CLOSED`.

---

## Bridge status ladder

Bridge's own KYC status progresses:

```
not_started → under_review → active   (rejected at any point on failure)
```

The backend maps Bridge `active` → `approved`. Watch the live status in the
**Bridge Dashboard → Customers** (find your customer by the `customerId`
returned in Step 1).

| Bridge status | Talise status |
| --- | --- |
| `not_started` | `unverified` / `pending` |
| `under_review` | `pending` |
| `active` | `approved` |
| `rejected` | `rejected` |

---

## Revert — re-close cash-out

When you're done testing, delete the `USD_WITHDRAWAL_OPEN=true` line from
`.env.local` (or set it to anything other than `true`) and restart
`npm run dev`. The cash-out endpoint will then return
`403 USD_WITHDRAWAL_CLOSED` again, re-closing the gate.
