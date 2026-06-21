import "server-only";

import {
  bridgeFetch,
  BRIDGE_SUI_RAIL,
  BRIDGE_SUI_CURRENCY,
} from "./client";
import type { BridgeFiatCurrency, BridgeTransfer } from "./onramp";

/**
 * Bridge OFF-RAMP: USDC on Sui → fiat to the user's bank.
 *
 * Bridge works in USDC on Sui (currency "usdc"), so Talise swaps the user's
 * USDsui → USDC before it reaches Bridge; the API leg below is pure USDC.
 *
 * Two primitives:
 *   1. External Account — register the payout bank account (US ACH or
 *      SEPA/IBAN). Returns an `id` used below.
 *   2. Liquidation Address — a PERSISTENT Sui address bound to that external
 *      account. Any USDC sent there is paid out as fiat. This is the clean
 *      cash-out UX: Talise shows one address; USDC in → fiat to their bank.
 *      Settlement arrives as `liquidation_address.drain.*` webhooks.
 *
 * For a one-off cash-out without a persistent address, `createOfframpTransfer`
 * returns a single-use Sui deposit address instead.
 *
 * Fiat destinations: USD (ACH/wire), EUR (SEPA), GBP (Faster Payments). NOT
 * NGN — Nigerian payout stays on Linq.
 */

// ── External accounts (payout bank) ──────────────────────────────────

export type BridgeExternalAccount = {
  id: string;
  customer_id: string;
  currency: string;
  account_owner_name: string;
  account_type: string;
  active: boolean;
  bank_name?: string;
  last_4?: string;
  account?: {
    last_4?: string;
    routing_number?: string;
    checking_or_savings?: string;
  };
};

/** List a customer's registered payout (external) bank accounts. */
export async function listExternalAccounts(
  customerId: string
): Promise<{ data: BridgeExternalAccount[] }> {
  return bridgeFetch<{ data: BridgeExternalAccount[] }>(
    `customers/${encodeURIComponent(customerId)}/external_accounts`
  );
}

/** Register a US ACH payout account. */
export async function createUsAchExternalAccount(input: {
  customerId: string;
  accountOwnerName: string;
  accountNumber: string;
  routingNumber: string;
  checkingOrSavings?: "checking" | "savings";
  bankName?: string;
  /** First/last default to splitting `accountOwnerName` when omitted. */
  firstName?: string;
  lastName?: string;
  address?: {
    street_line_1: string;
    city: string;
    state: string;
    postal_code: string;
    country: string; // ISO alpha-3, e.g. "USA"
  };
  idempotencyKey: string;
}): Promise<BridgeExternalAccount> {
  const parts = input.accountOwnerName.trim().split(/\s+/).filter(Boolean);
  const firstName = input.firstName ?? parts[0] ?? "";
  const lastName = input.lastName ?? parts.slice(1).join(" ");
  return bridgeFetch<BridgeExternalAccount>(
    `customers/${encodeURIComponent(input.customerId)}/external_accounts`,
    {
      method: "POST",
      idempotencyKey: input.idempotencyKey,
      body: {
        currency: "usd",
        account_type: "us",
        account_owner_type: "individual",
        account_owner_name: input.accountOwnerName,
        first_name: firstName,
        last_name: lastName,
        ...(input.bankName ? { bank_name: input.bankName } : {}),
        account: {
          account_number: input.accountNumber,
          routing_number: input.routingNumber,
          checking_or_savings: input.checkingOrSavings ?? "checking",
        },
        ...(input.address ? { address: input.address } : {}),
      },
    }
  );
}

/** Register a SEPA / IBAN payout account (EUR). */
export async function createIbanExternalAccount(input: {
  customerId: string;
  accountOwnerName: string;
  firstName: string;
  lastName: string;
  iban: string;
  bic: string;
  country: string; // ISO alpha-3
  bankName?: string;
  address?: {
    street_line_1: string;
    city: string;
    postal_code: string;
    country: string;
  };
  idempotencyKey: string;
}): Promise<BridgeExternalAccount> {
  return bridgeFetch<BridgeExternalAccount>(
    `customers/${encodeURIComponent(input.customerId)}/external_accounts`,
    {
      method: "POST",
      idempotencyKey: input.idempotencyKey,
      body: {
        currency: "eur",
        account_type: "iban",
        account_owner_type: "individual",
        account_owner_name: input.accountOwnerName,
        first_name: input.firstName,
        last_name: input.lastName,
        ...(input.bankName ? { bank_name: input.bankName } : {}),
        iban: { account_number: input.iban, bic: input.bic, country: input.country },
        ...(input.address ? { address: input.address } : {}),
      },
    }
  );
}

// ── Liquidation address (persistent USDsui → fiat cash-out) ───────────

export type BridgeLiquidationAddress = {
  id: string;
  /** The persistent Sui address the user sends USDsui to. */
  address: string;
  chain: string;
  currency: string;
  state: string;
  destination_payment_rail?: string;
  destination_currency?: string;
  external_account_id?: string;
};

/**
 * Create a persistent USDsui-on-Sui liquidation address that pays out to
 * `externalAccountId` in `destinationCurrency` over `destinationPaymentRail`
 * (e.g. ach / sepa / faster_payments). The returned `address` is what Talise
 * shows the user to cash out — USDsui in, fiat to their bank out.
 */
export async function createSuiLiquidationAddress(input: {
  customerId: string;
  externalAccountId: string;
  destinationPaymentRail: string;
  destinationCurrency: BridgeFiatCurrency;
  /** Optional Talise fee override, string percent. */
  customDeveloperFeePercent?: string;
  idempotencyKey: string;
}): Promise<BridgeLiquidationAddress> {
  return bridgeFetch<BridgeLiquidationAddress>(
    `customers/${encodeURIComponent(input.customerId)}/liquidation_addresses`,
    {
      method: "POST",
      idempotencyKey: input.idempotencyKey,
      body: {
        chain: BRIDGE_SUI_RAIL,
        currency: BRIDGE_SUI_CURRENCY,
        external_account_id: input.externalAccountId,
        destination_payment_rail: input.destinationPaymentRail,
        destination_currency: input.destinationCurrency,
        ...(input.customDeveloperFeePercent
          ? { custom_developer_fee_percent: input.customDeveloperFeePercent }
          : {}),
      },
    }
  );
}

/** List a customer's liquidation addresses (reuse an existing one per corridor). */
export async function listLiquidationAddresses(
  customerId: string
): Promise<{ data: BridgeLiquidationAddress[] }> {
  return bridgeFetch<{ data: BridgeLiquidationAddress[] }>(
    `customers/${encodeURIComponent(customerId)}/liquidation_addresses`
  );
}

/** List a customer's transfers, including persistent static templates. */
export async function listTransfers(
  customerId: string
): Promise<{ count: number; data: BridgeTransfer[] }> {
  return bridgeFetch<{ count: number; data: BridgeTransfer[] }>(
    `transfers?customer_id=${encodeURIComponent(customerId)}&limit=50`
  );
}

/**
 * Find an existing persistent cash-out address for a corridor — a static
 * transfer template ("payment route") first, then a liquidation address for
 * back-compat. Prefers an exact `wantRail` match but falls back to any active
 * route in the same currency, so whatever the user (or the Bridge dashboard)
 * set up is reused rather than duplicated. Returns the Sui deposit address +
 * its real payout rail, or undefined if no route exists yet.
 *
 * Shared by the cash-out setup route (to surface the address) and the
 * withdraw-prepare route (to target the swap-and-send PTB at it).
 */
export async function findExistingCashout(
  customerId: string,
  currency: string,
  wantRail: string
): Promise<{ address: string; rail: string; externalAccountId?: string } | undefined> {
  try {
    const transfers = await listTransfers(customerId);
    const templates = (transfers.data ?? []).filter(
      (t) =>
        t.features?.static_template === true &&
        t.amount == null &&
        t.state !== "canceled" &&
        t.state !== "returned" &&
        t.destination?.currency?.toLowerCase() === currency &&
        !!t.source_deposit_instructions?.to_address
    );
    const pick =
      templates.find(
        (t) => t.destination?.payment_rail?.toLowerCase() === wantRail
      ) ?? templates[0];
    const addr = pick?.source_deposit_instructions?.to_address;
    if (addr) {
      return {
        address: addr,
        rail: pick?.destination?.payment_rail?.toLowerCase() ?? wantRail,
        externalAccountId: pick?.destination?.external_account_id,
      };
    }
  } catch {
    /* fall through to liquidation addresses */
  }
  try {
    const las = await listLiquidationAddresses(customerId);
    const active = (las.data ?? []).filter(
      (x) => x.destination_currency?.toLowerCase() === currency && x.state === "active"
    );
    const pick =
      active.find((x) => x.destination_payment_rail?.toLowerCase() === wantRail) ??
      active[0];
    if (pick?.address) {
      return {
        address: pick.address,
        rail: pick.destination_payment_rail?.toLowerCase() ?? wantRail,
        externalAccountId: pick.external_account_id,
      };
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * A human-friendly summary of the payout bank behind a cash-out route, for the
 * app to display ("paying out to Lead ••1324"). Best-effort — returns null if
 * the external account can't be fetched.
 */
export async function cashoutBankSummary(
  customerId: string,
  externalAccountId: string | undefined
): Promise<{ bankName?: string; last4?: string; accountOwnerName?: string; accountType?: string } | null> {
  if (!externalAccountId) return null;
  try {
    const ext = await listExternalAccounts(customerId);
    const a = (ext.data ?? []).find((x) => x.id === externalAccountId);
    if (!a) return null;
    return {
      bankName: a.bank_name,
      last4: a.last_4 ?? a.account?.last_4,
      accountOwnerName: a.account_owner_name,
      accountType: a.account?.checking_or_savings,
    };
  } catch {
    return null;
  }
}

/**
 * Create a PERSISTENT static off-ramp template (USDC on Sui → fiat). This is
 * the "payment route" shape the Bridge dashboard creates: no `amount` and no
 * `from_address`, with `flexible_amount` + `static_template` +
 * `allow_any_from_address` so the returned Sui deposit address
 * (`source_deposit_instructions.to_address`) is reusable for any amount, any
 * sender. Sending USDsui→USDC to that address pays out fiat over
 * `destinationPaymentRail` (e.g. "wire" / "ach") to `externalAccountId`.
 */
export async function createStaticOfframpTemplate(input: {
  customerId: string;
  externalAccountId: string;
  destinationPaymentRail: string; // "wire" | "ach" | "sepa"
  destinationCurrency: BridgeFiatCurrency;
  /** Talise fee, string percent (e.g. "0.1"). */
  developerFeePercent?: string;
  idempotencyKey: string;
}): Promise<BridgeTransfer> {
  return bridgeFetch<BridgeTransfer>("transfers", {
    method: "POST",
    idempotencyKey: input.idempotencyKey,
    body: {
      on_behalf_of: input.customerId,
      ...(input.developerFeePercent
        ? { developer_fee_percent: input.developerFeePercent }
        : {}),
      source: { payment_rail: BRIDGE_SUI_RAIL, currency: BRIDGE_SUI_CURRENCY },
      destination: {
        payment_rail: input.destinationPaymentRail,
        currency: input.destinationCurrency,
        external_account_id: input.externalAccountId,
      },
      features: {
        flexible_amount: true,
        static_template: true,
        allow_any_from_address: true,
      },
    },
  });
}

/**
 * One-off off-ramp transfer (USDC on Sui → fiat). Matches Bridge's canonical
 * off-ramp shape: the source is the user's Sui wallet (`fromAddress`) sending
 * USDC, and the payout `amount` lives in the DESTINATION (the USD the bank
 * receives). Bridge returns the Sui deposit address in
 * `source_deposit_instructions.to_address`. Use a liquidation address instead
 * for a persistent cash-out address.
 */
export async function createOfframpTransfer(input: {
  customerId: string;
  /** USD the bank should receive, decimal string — set on the destination. */
  amount: string;
  fromAddress: string; // the user's Sui wallet sending USDC
  externalAccountId: string;
  destinationPaymentRail: string;
  destinationCurrency: BridgeFiatCurrency;
  developerFee?: string;
  idempotencyKey: string;
  dryRun?: boolean;
}): Promise<BridgeTransfer> {
  return bridgeFetch<BridgeTransfer>("transfers", {
    method: "POST",
    idempotencyKey: input.idempotencyKey,
    body: {
      on_behalf_of: input.customerId,
      ...(input.developerFee ? { developer_fee: input.developerFee } : {}),
      ...(input.dryRun ? { dry_run: true } : {}),
      source: {
        payment_rail: BRIDGE_SUI_RAIL,
        currency: BRIDGE_SUI_CURRENCY,
        from_address: input.fromAddress,
      },
      destination: {
        amount: input.amount,
        payment_rail: input.destinationPaymentRail,
        currency: input.destinationCurrency,
        external_account_id: input.externalAccountId,
      },
    },
  });
}
