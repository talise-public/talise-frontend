#!/usr/bin/env node
/**
 * bridge-kyc-roundtrip.mjs
 *
 * LOCAL test harness for Talise's Bridge.xyz KYC + USD cash-out flow.
 * Drives the full round-trip against a locally running Next.js dev server:
 *
 *   1. POST /api/kyc/bridge/start            → get hosted KYC + ToS links
 *   2. GET  /api/kyc/bridge/status (poll)    → wait until status === "approved"
 *   3. POST /api/offramp/bridge/cashout-address (US ACH body)
 *                                            → get the persistent Sui address
 *                                              to send USDC to for cash-out
 *
 * ───────────────────────────────────────────────────────────────────────────
 * AUTH (verified against lib/mobile-sessions.ts → readEntryIdFromRequest):
 *   These routes authenticate either via a session cookie (web) OR an
 *   `Authorization: Bearer <token>` header (iOS app). This harness uses the
 *   Bearer header. The token is the SIGNED mobile bearer returned by
 *   issueMobileBearer() (i.e. the value the iOS app stores after sign-in) —
 *   pass that exact string. The header sent is literally:
 *
 *       Authorization: Bearer <TALISE_AUTH>
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ENV VARS:
 *   REQUIRED:
 *     TALISE_AUTH           Signed mobile bearer token (sent as
 *                           "Authorization: Bearer <TALISE_AUTH>").
 *     TEST_ACCOUNT_OWNER    Bank account owner name (e.g. "Jane Doe").
 *     TEST_ACCOUNT_NUMBER   US bank account number.
 *     TEST_ROUTING_NUMBER   US ABA routing number (9 digits).
 *     TEST_STREET           Billing street address.
 *     TEST_CITY             Billing city.
 *     TEST_STATE            Billing state (2-letter, e.g. "NY").
 *     TEST_POSTAL           Billing postal/ZIP code.
 *
 *   OPTIONAL:
 *     BASE_URL              Default "http://localhost:3000".
 *     POLL_SECONDS          Poll interval for status, default 10.
 *     POLL_MINUTES          Overall poll timeout, default 15.
 *     TEST_CHECKING_OR_SAVINGS  "checking" | "savings", default "checking".
 *
 * ───────────────────────────────────────────────────────────────────────────
 * EXAMPLE INVOCATION:
 *   TALISE_AUTH="<signed-bearer>" \
 *   TEST_ACCOUNT_OWNER="Jane Doe" \
 *   TEST_ACCOUNT_NUMBER="000123456789" \
 *   TEST_ROUTING_NUMBER="021000021" \
 *   TEST_STREET="123 Main St" \
 *   TEST_CITY="New York" \
 *   TEST_STATE="NY" \
 *   TEST_POSTAL="10001" \
 *   node scripts/bridge-kyc-roundtrip.mjs
 *
 * Requires Node 18+ (uses global fetch). No external deps.
 * ───────────────────────────────────────────────────────────────────────────
 */

const REQUIRED_ENV = [
  "TALISE_AUTH",
  "TEST_ACCOUNT_OWNER",
  "TEST_ACCOUNT_NUMBER",
  "TEST_ROUTING_NUMBER",
  "TEST_STREET",
  "TEST_CITY",
  "TEST_STATE",
  "TEST_POSTAL",
];

function usageAndExit() {
  console.error(`
Talise Bridge KYC + USD cash-out round-trip harness
===================================================

Missing required environment variables. Set ALL of the following and re-run.

REQUIRED:
  TALISE_AUTH           Signed mobile bearer token (Authorization: Bearer <TALISE_AUTH>)
  TEST_ACCOUNT_OWNER    Bank account owner name (e.g. "Jane Doe")
  TEST_ACCOUNT_NUMBER   US bank account number
  TEST_ROUTING_NUMBER   US ABA routing number (9 digits)
  TEST_STREET           Billing street address
  TEST_CITY             Billing city
  TEST_STATE            Billing state (2-letter, e.g. "NY")
  TEST_POSTAL           Billing postal/ZIP code

OPTIONAL:
  BASE_URL              Default "http://localhost:3000"
  POLL_SECONDS          Poll interval (seconds), default 10
  POLL_MINUTES          Poll timeout (minutes), default 15
  TEST_CHECKING_OR_SAVINGS  "checking" | "savings", default "checking"

Example:
  TALISE_AUTH="<signed-bearer>" \\
  TEST_ACCOUNT_OWNER="Jane Doe" \\
  TEST_ACCOUNT_NUMBER="000123456789" \\
  TEST_ROUTING_NUMBER="021000021" \\
  TEST_STREET="123 Main St" TEST_CITY="New York" TEST_STATE="NY" TEST_POSTAL="10001" \\
  node scripts/bridge-kyc-roundtrip.mjs
`);
  process.exit(1);
}

const env = process.env;
const missing = REQUIRED_ENV.filter((k) => !env[k] || !String(env[k]).trim());
if (missing.length) {
  console.error(`\n[!] Missing: ${missing.join(", ")}`);
  usageAndExit();
}

const BASE_URL = (env.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const POLL_SECONDS = Math.max(1, Number(env.POLL_SECONDS) || 10);
const POLL_MINUTES = Math.max(1, Number(env.POLL_MINUTES) || 15);
const CHECKING_OR_SAVINGS = (env.TEST_CHECKING_OR_SAVINGS || "checking").trim();

const AUTH_HEADERS = {
  Authorization: `Bearer ${env.TALISE_AUTH.trim()}`,
  "Content-Type": "application/json",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch + parse JSON. On any non-2xx, print HTTP status + body and exit(1),
 * UNLESS the caller marks the status as "expected" (so it can handle it).
 */
async function call(method, path, { body, expectStatuses = [] } = {}) {
  const url = `${BASE_URL}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: AUTH_HEADERS,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    console.error(`\n[x] Network error calling ${method} ${url}`);
    console.error(`    ${e?.message || e}`);
    console.error(`    Is the dev server running? (npm run dev → ${BASE_URL})`);
    process.exit(1);
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { _raw: text };
  }

  if (!res.ok && !expectStatuses.includes(res.status)) {
    console.error(`\n[x] ${method} ${path} → HTTP ${res.status}`);
    console.error(`    Body: ${text || "(empty)"}`);
    process.exit(1);
  }

  return { status: res.status, json, text };
}

function hr() {
  console.log("─".repeat(70));
}

async function stepStart() {
  hr();
  console.log("STEP 1 — Start Bridge KYC + ToS");
  hr();
  const { json } = await call("POST", "/api/kyc/bridge/start");
  const { provider, status, kycUrl, tosUrl, kycLinkId, customerId } = json;

  console.log(`  provider:    ${provider}`);
  console.log(`  status:      ${status}`);
  console.log(`  kycLinkId:   ${kycLinkId ?? "(none)"}`);
  console.log(`  customerId:  ${customerId ?? "(none)"}`);
  console.log("");
  console.log("  >>> Open these TWO URLs in a browser to complete identity + ToS:");
  console.log("");
  console.log(`      KYC (identity):  ${kycUrl || "(not returned)"}`);
  console.log(`      ToS (terms):     ${tosUrl || "(not returned)"}`);
  console.log("");

  if (status === "approved") {
    console.log("  Already approved — skipping ahead to cash-out address.");
  }
  return json;
}

async function stepPollUntilApproved() {
  hr();
  console.log(
    `STEP 2 — Poll KYC status every ${POLL_SECONDS}s (timeout ${POLL_MINUTES}m)`
  );
  hr();

  const deadline = Date.now() + POLL_MINUTES * 60 * 1000;
  let n = 0;
  while (Date.now() < deadline) {
    n += 1;
    const { json } = await call("GET", "/api/kyc/bridge/status");
    const { started, status, kycStatus, tosStatus, customerId } = json;
    const ts = new Date().toISOString();
    console.log(
      `  [${ts}] poll #${n}  status=${status}  kyc=${kycStatus ?? "?"}  tos=${
        tosStatus ?? "?"
      }  started=${started}  customer=${customerId ?? "?"}`
    );

    if (status === "approved") {
      console.log("\n  KYC APPROVED. Proceeding to cash-out address.");
      return json;
    }
    if (status === "rejected") {
      console.error("\n[x] KYC was REJECTED by Bridge. Cannot continue.");
      console.error("    Check Bridge Dashboard → Customers for the reason.");
      process.exit(1);
    }
    if (status === "expired") {
      console.error("\n[x] KYC link EXPIRED. Re-run to mint a fresh link.");
      process.exit(1);
    }

    if (Date.now() + POLL_SECONDS * 1000 < deadline) {
      await sleep(POLL_SECONDS * 1000);
    } else {
      break;
    }
  }

  console.error(
    `\n[x] Timed out after ${POLL_MINUTES} minutes without reaching "approved".`
  );
  console.error("    KYC ladder: not_started → under_review → active(approved).");
  console.error("    Finish the hosted KYC + ToS in the browser, then re-run,");
  console.error("    or raise POLL_MINUTES.");
  process.exit(1);
}

async function stepCashoutAddress() {
  hr();
  console.log("STEP 3 — Request US ACH cash-out address");
  hr();

  const body = {
    rail: "ach",
    currency: "usd",
    accountOwnerName: env.TEST_ACCOUNT_OWNER,
    accountNumber: env.TEST_ACCOUNT_NUMBER,
    routingNumber: env.TEST_ROUTING_NUMBER,
    checkingOrSavings: CHECKING_OR_SAVINGS,
    street: env.TEST_STREET,
    city: env.TEST_CITY,
    state: env.TEST_STATE,
    postalCode: env.TEST_POSTAL,
    country: "USA",
  };

  const { status, json } = await call(
    "POST",
    "/api/offramp/bridge/cashout-address",
    { body, expectStatuses: [403, 409] }
  );

  if (status === 409) {
    console.error("\n[x] 409 KYC_NOT_APPROVED");
    console.error(`    Body: ${JSON.stringify(json)}`);
    console.error(
      "    Bridge has not approved this customer yet. Finish the KYC + ToS"
    );
    console.error(
      "    flow in the browser and wait until status reaches approved, then re-run."
    );
    process.exit(1);
  }
  if (status === 403) {
    console.error("\n[x] 403 USD_WITHDRAWAL_CLOSED");
    console.error(`    Body: ${JSON.stringify(json)}`);
    console.error(
      "    The cash-out allowlist gate is closed. Set USD_WITHDRAWAL_OPEN=true"
    );
    console.error(
      "    in .env.local, restart `npm run dev`, then re-run this harness."
    );
    process.exit(1);
  }

  const { address, currency, destinationPaymentRail, note } = json;
  console.log("  CASH-OUT ADDRESS (send USDC here to trigger USD payout):");
  console.log("");
  console.log(`      Sui address:  ${address}`);
  console.log("");
  console.log("  Bank summary (where the USD will land):");
  console.log(`      currency:               ${currency}`);
  console.log(`      destinationPaymentRail: ${destinationPaymentRail}`);
  console.log(`      accountOwnerName:       ${env.TEST_ACCOUNT_OWNER}`);
  console.log(
    `      routing/account:        ${env.TEST_ROUTING_NUMBER} / ****${String(
      env.TEST_ACCOUNT_NUMBER
    ).slice(-4)}`
  );
  console.log(`      type:                   ${CHECKING_OR_SAVINGS}`);
  if (note) console.log(`      note:                   ${note}`);
  console.log("");
  console.log("  >>> To complete the round-trip, send a SMALL USDC amount");
  console.log(`      (e.g. $1) to the Sui address above:`);
  console.log("");
  console.log(`          ${address}`);
  console.log("");
  console.log(
    "      Bridge will convert USDC → USD and wire it to the bank account."
  );
  console.log("      Watch progress in Bridge Dashboard → Transfers.");
  return json;
}

async function main() {
  console.log("");
  console.log("Talise Bridge KYC + USD cash-out round-trip");
  console.log(`Base URL: ${BASE_URL}`);
  console.log("");

  const start = await stepStart();

  if (start.status !== "approved") {
    await stepPollUntilApproved();
  }

  await stepCashoutAddress();

  hr();
  console.log("DONE — round-trip prepared. Send the test USDC to finish.");
  hr();
}

main().catch((e) => {
  console.error("\n[x] Unexpected error:");
  console.error(e?.stack || e?.message || e);
  process.exit(1);
});
