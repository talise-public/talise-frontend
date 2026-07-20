import "server-only";

import {
  bridgeFetch,
  BRIDGE_SUI_RAIL,
  BRIDGE_SUI_CURRENCY,
} from "./client";

/**
 * Bridge ON-RAMP via Virtual Accounts.
 *
 * A virtual account is a persistent bank account number issued to a customer.
 * Any fiat they deposit (USD via ACH/FedNow/wire, EUR/GBP via SEPA/Faster
 * Payments) is auto-converted and delivered as **USDsui directly to their Sui
 * address**, no swap, no widget redirect. The user just sees "send money to
 * this account number / IBAN."
 *
 * This is the clean recurring-funding UX. (For a one-off, `createOnrampTransfer`
 * returns ad-hoc deposit instructions instead.)
 *
 * Source fiat currencies: usd | eur | gbp | mxn | brl | cop. NGN is NOT
 * supported by Bridge, Nigerian local payout stays on Linq.
 */

export type BridgeFiatCurrency = "usd" | "eur" | "gbp" | "mxn" | "brl" | "cop";

/** USD virtual accounts return ACH/wire coordinates; EUR/GBP return IBAN/BIC. */
export type BridgeDepositInstructions = {
  currency: string;
  payment_rails?: string[];
  bank_name?: string;
  /** Receiving bank's mailing address (e.g. Lead Bank, Kansas City MO). */
  bank_address?: string;
  bank_account_number?: string;
  bank_routing_number?: string;
  bank_beneficiary_name?: string;
  /** Account holder's address on file, sending forms ask for it. */
  bank_beneficiary_address?: string;
  iban?: string;
  bic?: string;
  /** Some rails require this memo on the deposit. */
  deposit_message?: string;
};

export type BridgeVirtualAccount = {
  id: string;
  status: string;
  customer_id: string;
  source_deposit_instructions: BridgeDepositInstructions;
  destination?: {
    currency: string;
    payment_rail: string;
    address: string;
  };
};

/**
 * Create (or fetch, via Bridge's idempotency) a virtual account that mints
 * USDsui to `suiAddress` whenever `sourceCurrency` fiat is deposited.
 *
 * `developerFeePercent` is Talise's take as a string percent (e.g. "0.5" for
 * 0.5%). Omit for none.
 */
export async function createVirtualAccount(input: {
  customerId: string;
  suiAddress: string;
  sourceCurrency: BridgeFiatCurrency;
  developerFeePercent?: string;
  /** Stable Talise-owned key (e.g. `va-<userId>-<ccy>`). */
  idempotencyKey: string;
}): Promise<BridgeVirtualAccount> {
  return bridgeFetch<BridgeVirtualAccount>(
    `customers/${encodeURIComponent(input.customerId)}/virtual_accounts`,
    {
      method: "POST",
      idempotencyKey: input.idempotencyKey,
      body: {
        ...(input.developerFeePercent
          ? { developer_fee_percent: input.developerFeePercent }
          : {}),
        source: { currency: input.sourceCurrency },
        destination: {
          currency: BRIDGE_SUI_CURRENCY,
          payment_rail: BRIDGE_SUI_RAIL,
          address: input.suiAddress,
        },
      },
    }
  );
}

/** List a customer's virtual accounts (e.g. to reuse one already minted). */
export async function listVirtualAccounts(
  customerId: string
): Promise<{ data: BridgeVirtualAccount[] }> {
  return bridgeFetch<{ data: BridgeVirtualAccount[] }>(
    `customers/${encodeURIComponent(customerId)}/virtual_accounts`
  );
}

export type BridgeTransfer = {
  id: string;
  state: string;
  amount: string | null;
  currency?: string;
  on_behalf_of?: string;
  source?: { payment_rail?: string; currency?: string; from_address?: string | null };
  destination?: {
    payment_rail?: string;
    currency?: string;
    external_account_id?: string;
  };
  developer_fee_percent?: string;
  /** Static templates accept any amount from any sender; reusable cash-out. */
  features?: {
    flexible_amount?: boolean;
    static_template?: boolean;
    allow_any_from_address?: boolean;
  };
  source_deposit_instructions?: BridgeDepositInstructions & { to_address?: string };
};

/**
 * One-off on-ramp transfer: deliver `amount` of USDsui to `suiAddress` once
 * the user funds the returned `source_deposit_instructions`. Use this for a
 * single top-up where a persistent virtual account isn't wanted.
 */
export async function createOnrampTransfer(input: {
  customerId: string;
  amount: string; // decimal string, source fiat units
  sourceCurrency: BridgeFiatCurrency;
  sourcePaymentRail: string; // e.g. "ach_push", "wire", "sepa"
  suiAddress: string;
  developerFee?: string;
  idempotencyKey: string;
  dryRun?: boolean;
}): Promise<BridgeTransfer> {
  return bridgeFetch<BridgeTransfer>("transfers", {
    method: "POST",
    idempotencyKey: input.idempotencyKey,
    body: {
      on_behalf_of: input.customerId,
      amount: input.amount,
      ...(input.developerFee ? { developer_fee: input.developerFee } : {}),
      ...(input.dryRun ? { dry_run: true } : {}),
      source: { payment_rail: input.sourcePaymentRail, currency: input.sourceCurrency },
      destination: {
        payment_rail: BRIDGE_SUI_RAIL,
        currency: BRIDGE_SUI_CURRENCY,
        to_address: input.suiAddress,
      },
    },
  });
}
