/**
 * Sui Payment Kit wrapper.
 *
 * This module wires the @mysten/payment-kit SDK to Talise's USDsui invoice
 * flow. Each paid invoice mints an on-chain `PaymentReceipt` dynamic field
 * inside the merchant's `PaymentRegistry`, a durable, queryable proof
 * object that replaces the DB-only invoice slug as the source of truth.
 *
 * Docs: https://docs.sui.io/onchain-finance/payment-kit
 *
 * ---------------------------------------------------------------------------
 * V1 REGISTRY MODEL, GLOBAL SHARED REGISTRY
 * ---------------------------------------------------------------------------
 * We use a single registry named `TALISE_REGISTRY_NAME` shared across all
 * merchants. The registry id is deterministic, derived from
 * (namespaceId, registryName), so every merchant's `PaymentReceipt`
 * dynamic fields live under one well-known parent object. The per-merchant
 * `users.payment_registry_id` column is reserved for v2 when each merchant
 * gets their own registry + AdminCap (so they can manage funds independently).
 *
 * Why global v1: this ships immediately, no per-merchant bootstrap or
 * sponsored AdminCap dance. Duplicate-prevention is keyed by
 * (nonce, amount, receiver, coin_type) so two merchants sharing the same
 * registry can never collide, the receiver address differs.
 *
 * The receipt is uniquely addressable by its key: the registry parent +
 * the BCS-serialized `PaymentKey<USDSUI>(nonce, amount, receiver)`. We
 * surface `fieldId` (the on-chain object id of the dynamic field) as the
 * receipt object that the merchant "owns" (via being the receiver in the
 * proof).
 *
 * Bootstrap: the global registry must exist on-chain before any payment
 * can write to it. `/api/business/init-payment-registry` calls
 * `createRegistry` with the operator key once on first invocation. Idempotent
 *, repeated calls no-op once `getPaymentRecord` against the registry id
 * succeeds (or we catch the "already exists" abort).
 */

import { Transaction } from "@mysten/sui/transactions";
import {
  PaymentKitClient,
  type PaymentKitCompatibleClient,
} from "@mysten/payment-kit";
import { sui, network } from "./sui";
import { USDSUI_TYPE } from "./usdsui";

/**
 * Mainnet namespace object id for Sui Payment Kit. Documented in the kit
 * README; mirrored here so we don't depend on internal SDK exports.
 */
const MAINNET_NAMESPACE_ID =
  "0xccd3e4c7802921991cd9ce488c4ca0b51334ba75483702744242284ccf3ae7c2";
const TESTNET_NAMESPACE_ID =
  "0xa5016862fdccba7cc576b56cc5a391eda6775200aaa03a6b3c97d512312878db";

/**
 * Talise's global registry name. Combined with the namespace id this
 * deterministically derives the registry object id used for every invoice.
 */
export const TALISE_REGISTRY_NAME = "talise";

/** Returns the mainnet namespace object id we're using. */
export function namespaceObjectId(): string {
  return network() === "testnet" ? TESTNET_NAMESPACE_ID : MAINNET_NAMESPACE_ID;
}

let _client: PaymentKitClient | null = null;

export function paymentKitClient(): PaymentKitClient {
  if (_client) return _client;
  // SuiJsonRpcClient implements ClientWithCoreApi (it exposes `.core` and
  // `.network`), which is what PaymentKitClient needs.
  _client = new PaymentKitClient({
    client: sui() as unknown as PaymentKitCompatibleClient,
  });
  return _client;
}

/** Deterministic registry id for Talise's global v1 registry. */
export function globalRegistryId(): string {
  return paymentKitClient().getRegistryIdFromName(TALISE_REGISTRY_NAME);
}

/**
 * Feature flag: are Payment Kit receipts wired into the platform-wide
 * send flows (transfer, payroll, bills, remittance)?
 *
 * Dynamic, browser-side: we only enable receipts when localStorage has
 * `talise:pk:ready=1`, which the warmup endpoint sets ONLY after it has
 * confirmed (or successfully minted) the registry on chain. This avoids
 * the race where the user clicks Send before the lazy mint finishes -
 * which produced "Object 0xdad…908 does not exist" failures.
 *
 * Env override: NEXT_PUBLIC_PK_RECEIPTS_ENABLED=false force-disables
 * receipts even if the registry is ready (kill switch).
 *
 * Without receipts, suivision.xyz shows "none" as the transaction kind.
 */
export function paymentKitReceiptsEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_PK_RECEIPTS_ENABLED === "false") return false;
  if (typeof window === "undefined") return false; // SSR: never on
  try {
    return window.localStorage.getItem("talise:pk:ready") === "1";
  } catch {
    return false;
  }
}

/**
 * Called by the warmup client component once `/api/zk/warmup` confirms
 * the registry exists. Subsequent sends in this browser will attach
 * Payment Kit receipts. Persists across sessions, so the user only
 * pays the cold mint once.
 */
export function markPaymentKitReady() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem("talise:pk:ready", "1");
  } catch {}
}

/**
 * Build a PTB that:
 *   1. Optionally creates a PaymentRegistry (when `registry` is null).
 *   2. Transfers USDsui from sender to merchant.
 *   3. Calls payment-kit `processRegistryPayment` to mint a PaymentReceipt
 *      with { nonce = invoiceSlug, amount, receiver, coin_type } so duplicate
 *      `(nonce, receiver, amount)` pairs fail.
 *
 * The kit's `processRegistryPayment` call internally pulls the exact USDsui
 * amount from the caller's wallet (via `coinWithBalance`), we don't need
 * a separate `transferObjects`. The PaymentRecord dynamic field that gets
 * minted IS the receipt; the merchant takes custody of the USDsui balance.
 */
export function buildPayWithReceipt(opts: {
  sender: string;
  /** Existing registry id, or null to mint a new one inline. */
  registry: string | null;
  /** Recipient address, the merchant. */
  merchant: string;
  /** USDsui amount in dollars (will be converted to micro-units, 6 decimals). */
  amountUsdsui: number;
  /** Invoice slug, used as the receipt nonce. */
  invoiceSlug: string;
}): { build: (tx: Transaction) => void | Promise<void> } {
  const client = paymentKitClient();
  const amountMicro = BigInt(Math.round(opts.amountUsdsui * 1e6));

  return {
    build: (tx: Transaction) => {
      // If no registry id was provided we mint one inline with the canonical
      // Talise name. The id is deterministic so subsequent calls reuse it.
      if (!opts.registry) {
        tx.add(
          client.calls.createRegistry({ registryName: TALISE_REGISTRY_NAME })
        );
      }

      tx.add(
        client.calls.processRegistryPayment({
          registryId: opts.registry ?? globalRegistryId(),
          nonce: opts.invoiceSlug,
          amount: amountMicro,
          receiver: opts.merchant,
          coinType: USDSUI_TYPE,
          sender: opts.sender,
        })
      );
    },
  };
}

/**
 * Reads the on-chain receipt for an invoice. Used by the invoice list and
 * the pay-merchant success view. Returns null if the receipt hasn't been
 * indexed yet (RPC consistency lag) or doesn't exist.
 */
export async function fetchReceipt(opts: {
  registry: string;
  invoiceSlug: string;
  amountUsdsui: number;
  merchant: string;
}): Promise<{
  digest: string;
  amount: number;
  payer: string;
  timestampMs: number;
  objectId: string;
} | null> {
  try {
    const amountMicro = BigInt(Math.round(opts.amountUsdsui * 1e6));
    const record = await paymentKitClient().getPaymentRecord({
      registryId: opts.registry,
      nonce: opts.invoiceSlug,
      amount: amountMicro,
      receiver: opts.merchant,
      coinType: USDSUI_TYPE,
    });
    if (!record) return null;
    // The SDK gives us the field id (object id of the dynamic field that IS
    // the receipt) and the digest of the tx that wrote it. Amount + payer
    // are known to the caller (they're inputs to the key derivation).
    return {
      objectId: record.key,
      digest: record.paymentTransactionDigest ?? "",
      amount: opts.amountUsdsui,
      payer: "",
      // epoch_at_time_of_record is a Sui epoch; we can't cheaply convert to ms
      // without a network round-trip, so callers should fall back to the tx
      // timestamp when this is 0.
      timestampMs: 0,
    };
  } catch {
    return null;
  }
}

/**
 * Suiscan URL for the receipt object so the UI can link out.
 */
export function suiscanReceiptUrl(objectId: string): string {
  return `https://suiscan.xyz/${network()}/object/${objectId}`;
}

// ---------------------------------------------------------------------------
// Platform-wide receipt attachment
// ---------------------------------------------------------------------------
//
// Every USDsui payment Talise processes, sends, payroll legs, bill payments,
// remittance settlements, registers under the global `talise` registry so
// the transaction is provably part of our app on chain. The PaymentKey hash
// includes (nonce, amount, receiver, coin_type), so uniqueness only requires
// the nonce to differ when the other fields match.

/**
 * Generate a unique-enough nonce for a non-invoice payment. Format:
 *
 *   <kind>:<sender6>:<receiver6>:<base36-timestamp>:<base36-random>
 *
 * Short, sortable-ish, and collision-safe in practice. We don't need
 * cryptographic uniqueness, PaymentKit's PaymentKey collision check guards
 * the rest (an attacker can't replay a tx since amounts + receivers are
 * different from any real prior payment).
 */
export function nonceFor(
  kind: string,
  sender: string,
  receiver: string,
  suffix?: string
): string {
  const s = sender.slice(2, 8);
  const r = receiver.slice(2, 8);
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  const sfx = suffix ? `:${suffix}` : "";
  return `${kind}:${s}:${r}:${ts}:${rand}${sfx}`;
}

/**
 * Generic USDsui transfer that mints a Talise PaymentReceipt. Identical
 * mechanism to `buildPayWithReceipt` but with a caller-supplied nonce so it
 * works for any payment type (not just invoices).
 *
 * The PTB:
 *   1. Optionally bootstraps the Talise global registry if it doesn't exist.
 *   2. Calls payment-kit `processRegistryPayment`, pulls USDsui from sender,
 *      transfers to receiver, mints PaymentReceipt under the talise registry.
 *
 * Returns the same `{ build }` shape as our other PTB builders so the
 * Payment Intent layer can compose it cleanly.
 */
export function buildUsdsuiTransferWithReceipt(opts: {
  sender: string;
  receiver: string;
  amountUsdsui: number;
  nonce: string;
}): { build: (tx: Transaction) => void } {
  const client = paymentKitClient();
  const amountMicro = BigInt(Math.round(opts.amountUsdsui * 1e6));
  const registryId = globalRegistryId();

  return {
    build: (tx: Transaction) => {
      tx.add(
        client.calls.processRegistryPayment({
          registryId,
          nonce: opts.nonce,
          amount: amountMicro,
          receiver: opts.receiver,
          coinType: USDSUI_TYPE,
          sender: opts.sender,
        })
      );
    },
  };
}

/**
 * Multi-recipient variant for payroll / bill-batch / any list-of-payments.
 * One `processRegistryPayment` call per recipient, all in one atomic PTB.
 * Each recipient gets their own PaymentReceipt under the talise registry.
 */
export function buildUsdsuiBatchWithReceipts(opts: {
  sender: string;
  kind: string;
  recipients: Array<{
    address: string;
    amountUsdsui: number;
    /** Optional per-recipient label, encoded into the nonce for traceability. */
    label?: string;
  }>;
}): { build: (tx: Transaction) => void } {
  const client = paymentKitClient();
  const registryId = globalRegistryId();

  return {
    build: (tx: Transaction) => {
      for (let i = 0; i < opts.recipients.length; i++) {
        const r = opts.recipients[i];
        // Use the SAME compact nonce shape as single sends (`nonceFor`), the
        // Payment Kit `validate_nonce` rejects over-long nonces (EInvalidNonce),
        // and the old `${kind}:…:${i}:${label}` form blew past that cap. A short
        // fixed prefix + the leg index keeps every nonce unique within the batch.
        const nonce = nonceFor("pb", opts.sender, r.address, String(i));
        const amountMicro = BigInt(Math.round(r.amountUsdsui * 1e6));
        tx.add(
          client.calls.processRegistryPayment({
            registryId,
            nonce,
            amount: amountMicro,
            receiver: r.address,
            coinType: USDSUI_TYPE,
            sender: opts.sender,
          })
        );
      }
    },
  };
}
