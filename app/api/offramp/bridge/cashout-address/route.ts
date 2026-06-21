import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { usdWithdrawalAllowed, USD_WITHDRAWAL_CLOSED_MESSAGE } from "@/lib/offramp-access";
import { getOnrampKyc } from "@/lib/onramp/kyc-store";
import { bridgeConfigured } from "@/lib/bridge/client";
import {
  createUsAchExternalAccount,
  createIbanExternalAccount,
  createStaticOfframpTemplate,
  findExistingCashout,
  cashoutBankSummary,
} from "@/lib/bridge/offramp";
import type { BridgeFiatCurrency } from "@/lib/bridge/onramp";
import { sui, COIN_TYPES } from "@/lib/sui";

/** Best-effort USDC pocket balance (raw u64 micros string) for the user. */
async function usdcPocketMicros(address: string): Promise<string> {
  try {
    // gRPC getBalance returns { balance: { balance: "<raw u64>" } } (NOT
    // `totalBalance` like the JSON-RPC client) — see balances route.
    const b = await sui().getBalance({ owner: address, coinType: COIN_TYPES.USDC });
    return String((b as { balance?: { balance?: string } }).balance?.balance ?? "0");
  } catch {
    return "0";
  }
}

export const runtime = "nodejs";

/**
 * POST /api/offramp/bridge/cashout-address
 *
 * Bridge off-ramp: register the user's payout bank account and return a
 * PERSISTENT Sui address. USDsui sent to that address is auto-converted and
 * paid out as fiat to their bank (USD via ACH, EUR via SEPA). The user simply
 * sends USDsui to the address to cash out.
 *
 * Reuses the Bridge customer minted during on-ramp KYC (`onramp_kyc`); the
 * customer must exist (KYC started) — Bridge off-ramp can't run for an
 * unverified user. 503 when Bridge isn't configured (env-gated, like every
 * Talise ramp partner). Does NOT touch any send/balance/limit path.
 *
 * Body (US ACH):
 *   { rail: "ach", currency: "usd", accountOwnerName, accountNumber,
 *     routingNumber, checkingOrSavings? }
 * Body (SEPA/IBAN):
 *   { rail: "sepa", currency: "eur", accountOwnerName, firstName, lastName,
 *     iban, bic, country }
 */
export async function POST(req: Request) {
  if (!bridgeConfigured()) {
    return NextResponse.json({ error: "bridge_offramp_disabled" }, { status: 503 });
  }
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });
  // USD withdrawal is gated to an allowlist during pilot (rolandojude18 only).
  if (!usdWithdrawalAllowed(user)) {
    return NextResponse.json(
      { error: USD_WITHDRAWAL_CLOSED_MESSAGE, code: "USD_WITHDRAWAL_CLOSED" },
      { status: 403 }
    );
  }

  // The Bridge customer is shared with the on-ramp; off-ramp requires it.
  const kyc = await getOnrampKyc(userId);
  const customerId = kyc?.providerCustomerId;
  if (!customerId) {
    return NextResponse.json(
      { error: "complete identity verification first", code: "NO_BRIDGE_CUSTOMER" },
      { status: 409 }
    );
  }

  let body: {
    rail?: string;
    currency?: string;
    accountOwnerName?: string;
    accountNumber?: string;
    routingNumber?: string;
    checkingOrSavings?: "checking" | "savings";
    firstName?: string;
    lastName?: string;
    iban?: string;
    bic?: string;
    country?: string;
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const rail = String(body.rail ?? "").toLowerCase();
  const currency = String(body.currency ?? "").toLowerCase() as BridgeFiatCurrency;
  // Destination payout rail: explicit "wire" wins; else USD→ACH, EUR→SEPA.
  const wantRail = rail === "wire" ? "wire" : currency === "eur" ? "sepa" : "ach";

  try {
    // 1. REUSE-FIRST: if the user (or the Bridge dashboard) already has a
    //    persistent cash-out route for this corridor, return it with no form.
    const existing = await findExistingCashout(customerId, currency, wantRail);
    if (existing) {
      const [bank, usdcMicros] = await Promise.all([
        cashoutBankSummary(customerId, existing.externalAccountId),
        usdcPocketMicros(user.sui_address),
      ]);
      return NextResponse.json({
        address: existing.address,
        currency,
        destinationPaymentRail: existing.rail,
        note: "Send USDsui to this address to cash out to your bank.",
        bankName: bank?.bankName ?? null,
        accountLast4: bank?.last4 ?? null,
        accountOwnerName: bank?.accountOwnerName ?? null,
        accountType: bank?.accountType ?? null,
        usdcMicros,
      });
    }

    // 2. CREATE: no route yet — register the payout account from the form, then
    //    create a persistent static transfer template (the "payment route"
    //    shape) and return its Sui deposit address.
    if (!body.accountOwnerName) {
      return NextResponse.json({ error: "accountOwnerName required" }, { status: 400 });
    }
    let externalAccountId: string;
    if (currency === "usd") {
      if (!body.accountNumber || !body.routingNumber) {
        return NextResponse.json(
          { error: "accountNumber + routingNumber required for USD" },
          { status: 400 }
        );
      }
      // Bridge requires the account holder's address on US payout accounts.
      if (!body.street || !body.city || !body.state || !body.postalCode) {
        return NextResponse.json(
          { error: "street, city, state, postalCode required for USD" },
          { status: 400 }
        );
      }
      const ext = await createUsAchExternalAccount({
        customerId,
        accountOwnerName: body.accountOwnerName,
        accountNumber: body.accountNumber,
        routingNumber: body.routingNumber,
        checkingOrSavings: body.checkingOrSavings,
        address: {
          street_line_1: body.street,
          city: body.city,
          state: body.state,
          postal_code: body.postalCode,
          country: (body.country || "USA").toUpperCase(),
        },
        idempotencyKey: `ext-${userId}-usd`,
      });
      externalAccountId = ext.id;
    } else if (currency === "eur") {
      if (!body.iban || !body.bic || !body.firstName || !body.lastName || !body.country) {
        return NextResponse.json(
          { error: "iban, bic, firstName, lastName, country required for SEPA" },
          { status: 400 }
        );
      }
      const ext = await createIbanExternalAccount({
        customerId,
        accountOwnerName: body.accountOwnerName,
        firstName: body.firstName,
        lastName: body.lastName,
        iban: body.iban,
        bic: body.bic,
        country: body.country,
        idempotencyKey: `ext-${userId}-eur`,
      });
      externalAccountId = ext.id;
    } else {
      return NextResponse.json(
        { error: "unsupported currency (use usd or eur)", code: "UNSUPPORTED_RAIL" },
        { status: 400 }
      );
    }

    const tpl = await createStaticOfframpTemplate({
      customerId,
      externalAccountId,
      destinationPaymentRail: wantRail,
      destinationCurrency: currency,
      developerFeePercent: "0.1",
      idempotencyKey: `tpl-${userId}-${currency}-${wantRail}`,
    });
    const address = tpl.source_deposit_instructions?.to_address;
    if (!address) {
      return NextResponse.json(
        { error: "Couldn't set up cash-out. Please try again.", code: "BRIDGE_ERROR" },
        { status: 502 }
      );
    }

    return NextResponse.json({
      address, // the persistent Sui address to send USDsui to
      currency,
      destinationPaymentRail: wantRail,
      note: "Send USDsui to this address to cash out to your bank.",
    });
  } catch (e) {
    const msg = (e as Error).message || "bridge_offramp_failed";
    console.error(`[offramp/bridge] cashout-address failed user=${userId}: ${msg}`);
    return NextResponse.json(
      { error: "Couldn't set up cash-out. Please try again.", code: "BRIDGE_ERROR" },
      { status: 502 }
    );
  }
}
