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

/**
 * Transak on-ramp adapter, the LIVE money-in provider for Talise.
 *
 * Transak's HOSTED WIDGET performs KYC itself (tiered: light KYC for small
 * amounts, full ID for larger), so Talise collects no identity fields, we
 * just build the widget URL with the user's Sui address locked in. Transak
 * does NOT deliver USDsui; it delivers USDC on Sui, and a separate
 * swap-to-USDsui step (`/api/swap/prepare`) converts it. So this adapter
 * always reports `deliverAsset = USDC` and `requiresSwapToUsdsui = true`.
 *
 * With no `TRANSAK_API_KEY` set, `createOnrampSession` returns a deterministic
 * stub URL so the modal + routes can be exercised without a live account.
 * With the key set it builds a real Transak widget URL.
 *
 * Env:
 *   TRANSAK_API_KEY       partner API key (required to go live)
 *   TRANSAK_API_SECRET    webhook JWT signing secret (HS256)
 *   TRANSAK_ENVIRONMENT   "PRODUCTION" | "STAGING" (default STAGING)
 *   NEXT_PUBLIC_APP_URL   optional; used for the post-purchase redirect
 *
 * Docs: https://docs.transak.com  (widget params + webhook verification)
 */

const NAME: OnrampProviderName = "transak";
const DELIVER: DeliverAsset = "USDC";

function apiKey(): string | undefined {
  return process.env.TRANSAK_API_KEY || undefined;
}

function webhookSecret(): string | undefined {
  // Transak signs the webhook body as a JWT (HS256) with the API secret.
  return process.env.TRANSAK_API_SECRET || process.env.TRANSAK_API_KEY || undefined;
}

/** Production vs staging widget host, from TRANSAK_ENVIRONMENT (default STAGING). */
function widgetBase(): string {
  const env = (process.env.TRANSAK_ENVIRONMENT || "STAGING").toUpperCase();
  return env === "PRODUCTION"
    ? "https://global.transak.com"
    : "https://global-stg.transak.com";
}

export const transakAdapter: OnrampProvider = {
  name: NAME,
  displayName: "Transak (card → USDC on Sui, then swap to USDsui)",
  deliverAsset: DELIVER,
  // Transak's hosted widget runs the KYC, so Talise collects no fields.
  widgetCollectsKyc: true,

  async getRequirements(
    input: RequirementsInput
  ): Promise<RequirementsResult> {
    // The widget enforces KYC itself (it asks the user for whatever the
    // amount/country needs), so Talise requests NO fields up front. We still
    // surface the indicative tier from the local ladder for display, but
    // report nothing missing so the modal goes straight to checkout.
    const r = computeRequirements(input);
    return { ...r, missingFields: [], satisfied: true };
  },

  async createOrUpdateCustomer(profile: KycProfile): Promise<CustomerResult> {
    // No partner-KYC API call here, Transak verifies identity in its widget.
    // We only mint a STABLE partner reference so orders + webhooks reconcile
    // back to this user. Works identically with or without an API key.
    return {
      providerCustomerId: partnerRef(profile),
      status: "pending", // flips via verifyWebhook once Transak verifies
      dailyLimitCents: null,
      monthlyLimitCents: null,
    };
  },

  async createOnrampSession(input: SessionInput): Promise<SessionResult> {
    const key = apiKey();
    // Transak only delivers USDC, coerce regardless of what the caller asked.
    const deliverAsset: DeliverAsset = DELIVER;

    if (!key) {
      const params = new URLSearchParams({
        provider: NAME,
        customer: input.providerCustomerId,
        amountCents: String(input.amountCents),
        destination: input.destinationAddress,
        asset: deliverAsset,
        stub: "1",
      });
      return {
        provider: NAME,
        widgetUrl: `https://onramp.stub.local/transak?${params.toString()}`,
        deliverAsset,
        // Transak delivers USDC → a swap-to-USDsui step is still required.
        requiresSwapToUsdsui: true,
      };
    }

    // Live Transak BUY widget. Lock the destination to the user's Sui address
    // (disableWalletAddressForm) and pin the asset to USDC on the Sui network.
    // The user's KYC + card/bank payment all happen inside this widget; on
    // completion USDC lands on `destinationAddress`.
    const params = new URLSearchParams({
      apiKey: key,
      productsAvailed: "BUY",
      network: "sui",
      cryptoCurrencyCode: "USDC",
      defaultCryptoCurrency: "USDC",
      walletAddress: input.destinationAddress,
      disableWalletAddressForm: "true",
      fiatCurrency: "USD",
      defaultFiatAmount: String(Math.max(1, Math.round(input.amountCents / 100))),
      partnerCustomerId: input.providerCustomerId,
      themeColor: "2f7d31", // Talise green
    });
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
    if (appUrl) {
      params.set("redirectURL", `${appUrl.replace(/\/+$/, "")}/app?onramp=done`);
    }

    return {
      provider: NAME,
      widgetUrl: `${widgetBase()}?${params.toString()}`,
      deliverAsset,
      // Transak delivers USDC → a swap-to-USDsui step is still required.
      requiresSwapToUsdsui: true,
    };
  },

  async verifyWebhook(
    rawBody: string,
    _headers: Headers | Record<string, string>
  ): Promise<OnrampWebhookEvent> {
    const secret = webhookSecret();

    // Transak posts `{ data: "<JWT>" }` where the JWT is HS256-signed with
    // the API secret and its payload IS the order/event object. We verify the
    // signature and decode, falling back to the raw body for unsigned/test
    // posts (marked verified=false).
    let verified = false;
    let payload: Record<string, unknown> = {};
    try {
      const outer = JSON.parse(rawBody) as { data?: unknown };
      const token = typeof outer?.data === "string" ? outer.data : null;
      if (token && secret) {
        const decoded = verifyJwtHs256(token, secret);
        if (decoded) {
          verified = true;
          payload = decoded;
        }
      } else {
        // No JWT envelope, treat the body as the event object (unverified).
        payload = (outer ?? {}) as Record<string, unknown>;
      }
    } catch {
      payload = { _unparsed: rawBody };
    }

    // The order/event fields may be nested under `webhookData` or be top-level.
    const obj = ((payload.webhookData as Record<string, unknown>) ??
      payload) as Record<string, unknown>;
    const eventID =
      typeof payload.eventID === "string"
        ? payload.eventID
        : typeof obj.status === "string"
          ? obj.status
          : undefined;

    return {
      provider: NAME,
      verified,
      kind: mapKind(eventID),
      providerCustomerId:
        typeof obj.partnerCustomerId === "string"
          ? obj.partnerCustomerId
          : typeof obj.partner_customer_id === "string"
            ? obj.partner_customer_id
            : undefined,
      status: mapStatus(obj.kycStatus ?? obj.status),
      tier: mapTier(obj.kycTier ?? obj.kyc_tier),
      country: typeof obj.country === "string" ? obj.country : undefined,
      dailyLimitCents: numOrNull(obj.daily_limit_cents),
      monthlyLimitCents: numOrNull(obj.monthly_limit_cents),
      raw: payload,
    };
  },
};

// ── helpers ──────────────────────────────────────────────────────────

/** Stable per-user partner reference (Transak `partnerCustomerId`). */
function partnerRef(profile: KycProfile): string {
  const h = crypto
    .createHash("sha256")
    .update(`${profile.email}|${profile.country}`)
    .digest("hex")
    .slice(0, 16);
  return `talise_${h}`;
}

/** base64url decode → Buffer. */
function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Verify a compact HS256 JWT against `secret` and return its decoded payload,
 * or null if the signature doesn't match / the token is malformed. No external
 * dependency, Transak only ever uses HS256 for webhook signing.
 */
function verifyJwtHs256(
  token: string,
  secret: string
): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  try {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${h}.${p}`, "utf8")
      .digest(); // raw bytes
    const got = b64urlToBuf(sig);
    if (
      expected.length !== got.length ||
      !crypto.timingSafeEqual(expected, got)
    ) {
      return null;
    }
    const json = JSON.parse(b64urlToBuf(p).toString("utf8"));
    return json && typeof json === "object"
      ? (json as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mapKind(type?: string): OnrampWebhookEvent["kind"] {
  if (!type) return "unknown";
  const t = type.toLowerCase();
  if (t.includes("kyc") || t.includes("customer")) return "kyc.updated";
  if (t.includes("order") || t.includes("onramp")) return "onramp.completed";
  return "unknown";
}

function mapStatus(v: unknown): OnrampKycStatus | undefined {
  const s = typeof v === "string" ? v.toLowerCase() : undefined;
  if (!s) return undefined;
  const allowed: OnrampKycStatus[] = [
    "unverified",
    "pending",
    "approved",
    "rejected",
    "expired",
  ];
  return allowed.includes(s as OnrampKycStatus)
    ? (s as OnrampKycStatus)
    : undefined;
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
