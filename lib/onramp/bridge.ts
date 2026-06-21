import "server-only";

import crypto from "node:crypto";
import {
  type CustomerResult,
  type DeliverAsset,
  type OnrampProvider,
  type OnrampProviderName,
  type OnrampWebhookEvent,
  type RequirementsInput,
  type RequirementsResult,
  type SessionInput,
  type SessionResult,
  type KycProfile,
  type OnrampKycStatus,
  type OnrampKycTier,
} from "./types";
import { computeRequirements } from "./requirements";
import { bridgeDeveloperFeePercent } from "@/lib/bridge/client";
import { createKycLink, mapBridgeKycStatus } from "@/lib/bridge/customers";
import {
  createVirtualAccount,
  listVirtualAccounts,
  type BridgeFiatCurrency,
} from "@/lib/bridge/onramp";
import { verifyBridgeWebhook, parseBridgeWebhook } from "@/lib/bridge/webhook";

/**
 * Bridge on-ramp adapter — DEFAULT provider.
 *
 * Bridge (a Stripe company) is the issuer of USDsui ("Sui Dollar"), so this
 * adapter delivers USDSUI DIRECTLY on Sui — no swap step. It supports bank
 * + card funding.
 *
 * STUB: with no `BRIDGE_API_KEY` set, every method returns deterministic,
 * typed mock data so the routes + modal work end-to-end in dev. Each place a
 * real network call belongs is marked `// TODO(live):`.
 *
 * Docs (for the live wiring): https://apidocs.bridge.xyz
 */

const NAME: OnrampProviderName = "bridge";
// Bridge delivers USDC on Sui (currency "usdc" / rail "sui"), NOT USDsui — so
// the existing USDC→USDsui sweep (AutoConvertBanner) finishes money-in.
const DELIVER: DeliverAsset = "USDC";

function apiKey(): string | undefined {
  return process.env.BRIDGE_API_KEY || undefined;
}

export const bridgeAdapter: OnrampProvider = {
  name: NAME,
  displayName: "Bridge (USDC on Sui)",
  deliverAsset: DELIVER,

  async getRequirements(
    input: RequirementsInput
  ): Promise<RequirementsResult> {
    // Tier ladder is provider-agnostic; Bridge uses the shared engine.
    // TODO(live): if Bridge exposes a per-country requirements endpoint,
    // call it here and reconcile with the local ladder.
    return computeRequirements(input);
  },

  async createOrUpdateCustomer(profile: KycProfile): Promise<CustomerResult> {
    const key = apiKey();
    if (!key) {
      // STUB: deterministic customer id derived from the profile so repeat
      // calls in dev are stable. Status mirrors a fresh applicant in review.
      const providerCustomerId = stubCustomerId(profile);
      const status: OnrampKycStatus = profile.governmentIdRef
        ? "pending"
        : "approved"; // lite-only (no doc) is auto-approved in the stub
      return {
        providerCustomerId,
        status,
        dailyLimitCents: 1_000_00,
        monthlyLimitCents: 10_000_00,
      };
    }

    // LIVE: create a hosted KYC + ToS link. Bridge runs the whole identity
    // flow and creates the customer; we return the link's customer ref + the
    // hosted `kycUrl` to redirect the user to. No PII flows through Talise.
    const fullName = [profile.firstName, profile.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();
    const link = await createKycLink({
      email: profile.email,
      fullName: fullName || undefined,
      type: "individual",
      // Stable per-user key so retries return the same link within 24h.
      idempotencyKey: `kyc-${profile.email.toLowerCase()}`,
    });
    return {
      // customer_id is null until the user starts KYC; fall back to the link
      // id so we always persist a stable reference to reconcile webhooks.
      providerCustomerId: link.customer_id ?? link.id,
      status: mapBridgeKycStatus(link.kyc_status),
      kycUrl: link.kyc_link,
    };
  },

  async createOnrampSession(input: SessionInput): Promise<SessionResult> {
    const key = apiKey();
    if (!key) {
      // STUB: a fake hosted widget URL that encodes the request so a dev can
      // eyeball that the right address/amount flowed through. No real money.
      const params = new URLSearchParams({
        provider: NAME,
        customer: input.providerCustomerId,
        amountCents: String(input.amountCents),
        destination: input.destinationAddress,
        asset: input.deliverAsset,
        stub: "1",
      });
      return {
        provider: NAME,
        widgetUrl: `https://onramp.stub.local/bridge?${params.toString()}`,
        deliverAsset: input.deliverAsset,
        requiresSwapToUsdsui: false, // Bridge delivers USDsui directly
      };
    }

    // LIVE: create (idempotently) a USD virtual account that mints USDsui
    // straight to the user's Sui address on deposit. Bridge funds via bank
    // deposit, not a redirect widget, so we return `depositInstructions`
    // rather than a `widgetUrl`. (Funding currency defaults to USD; the
    // virtual account is persistent, so amountCents is informational here.)
    const allowed: BridgeFiatCurrency[] = ["usd", "eur", "gbp", "mxn", "brl", "cop"];
    const sourceCurrency: BridgeFiatCurrency = allowed.includes(
      input.sourceCurrency as BridgeFiatCurrency
    )
      ? (input.sourceCurrency as BridgeFiatCurrency)
      : "usd";
    // Reuse an existing matching virtual account if the customer already has
    // one (created here before, or in the Bridge dashboard) — this returns the
    // SAME persistent deposit instructions and avoids minting duplicates.
    let va: Awaited<ReturnType<typeof createVirtualAccount>> | null = null;
    try {
      const existing = await listVirtualAccounts(input.providerCustomerId);
      va =
        (existing.data ?? []).find(
          (v) =>
            v.destination?.address?.toLowerCase() ===
              input.destinationAddress.toLowerCase() &&
            (v.source_deposit_instructions?.currency ?? "").toLowerCase() ===
              sourceCurrency &&
            (v.status === "activated" || v.status === "active")
        ) ?? null;
    } catch {
      va = null; // list failed — fall through to create
    }
    if (!va) {
      va = await createVirtualAccount({
        customerId: input.providerCustomerId,
        suiAddress: input.destinationAddress,
        sourceCurrency,
        developerFeePercent: bridgeDeveloperFeePercent(), // Talise's take
        idempotencyKey: `va-${input.providerCustomerId}-${sourceCurrency}`,
      });
    }
    const di = va.source_deposit_instructions;
    return {
      provider: NAME,
      deliverAsset: input.deliverAsset, // USDC on Sui
      // Bridge delivers USDC; the AutoConvertBanner sweeps it to USDsui.
      requiresSwapToUsdsui: true,
      depositInstructions: {
        currency: di.currency,
        paymentRails: di.payment_rails,
        bankName: di.bank_name,
        bankAddress: di.bank_address,
        accountNumber: di.bank_account_number,
        routingNumber: di.bank_routing_number,
        // Bridge USD virtual accounts at Lead Bank are checking accounts; the
        // API doesn't echo the type, so surface the known constant for forms
        // that demand it. (Only meaningful for USD/ACH; harmless for SEPA.)
        accountType: di.currency?.toLowerCase() === "usd" ? "checking" : undefined,
        beneficiaryName: di.bank_beneficiary_name,
        beneficiaryAddress: di.bank_beneficiary_address,
        iban: di.iban,
        bic: di.bic,
        depositMessage: di.deposit_message,
      },
    };
  },

  async verifyWebhook(
    rawBody: string,
    headers: Headers | Record<string, string>
  ): Promise<OnrampWebhookEvent> {
    // Bridge signs with RSA (X-Webhook-Signature: t=<ms>,v0=<base64>) over
    // `${t}.${rawBody}`, verified with the per-endpoint public key. Verify
    // BEFORE parsing — the real scheme, not the old HMAC placeholder.
    const v = verifyBridgeWebhook(rawBody, headers);
    const evt = parseBridgeWebhook(rawBody);
    const obj = (evt.event_object ?? {}) as Record<string, unknown>;

    return {
      provider: NAME,
      verified: v.verified,
      kind: mapKind(evt.event_type),
      providerCustomerId:
        typeof obj.id === "string" && evt.event_category === "customer"
          ? obj.id
          : typeof obj.customer_id === "string"
            ? obj.customer_id
            : evt.event_object_id,
      // Bridge sends the lifecycle string in event_object_status / object.status.
      // Only customer events carry a KYC status; transfer events leave it unset.
      status:
        evt.event_category === "customer"
          ? mapBridgeKycStatus(
              (evt.event_object_status ?? (obj.status as string)) || undefined
            )
          : undefined,
      tier: mapTier(obj.kyc_tier),
      country: typeof obj.country === "string" ? obj.country : undefined,
      dailyLimitCents: numOrNull(obj.daily_limit_cents),
      monthlyLimitCents: numOrNull(obj.monthly_limit_cents),
      raw: evt,
    };
  },
};

// ── helpers ──────────────────────────────────────────────────────────

function stubCustomerId(profile: KycProfile): string {
  const h = crypto
    .createHash("sha256")
    .update(`${profile.email}|${profile.country}`)
    .digest("hex")
    .slice(0, 16);
  return `bridge_stub_${h}`;
}

function mapKind(type?: string): OnrampWebhookEvent["kind"] {
  if (!type) return "unknown";
  if (type.includes("kyc") || type.includes("customer")) return "kyc.updated";
  if (type.includes("onramp") || type.includes("transfer"))
    return "onramp.completed";
  return "unknown";
}

function mapTier(v: unknown): OnrampKycTier | undefined {
  const t = typeof v === "string" ? v : undefined;
  if (!t) return undefined;
  const allowed: OnrampKycTier[] = ["none", "lite", "standard", "enhanced"];
  return allowed.includes(t as OnrampKycTier)
    ? (t as OnrampKycTier)
    : undefined;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
