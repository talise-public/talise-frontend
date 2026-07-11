import "server-only";

import { bridgeFetch } from "./client";
import type { OnrampKycStatus } from "@/lib/onramp/types";

/**
 * Bridge Customers + KYC. Two ways to onboard:
 *
 *   1. Hosted KYC Link (preferred for Talise) — `createKycLink` returns a
 *      `kyc_link` URL we redirect the user to; Bridge runs the whole identity
 *      + ToS flow and creates the customer for us. We poll / webhook the
 *      status. No PII flows through Talise servers.
 *
 *   2. Direct customer create — `createCustomer` posts the applicant PII
 *      ourselves (needs a `signed_agreement_id` from the ToS flow to transact).
 *
 * Status strings are Bridge's; `mapBridgeKycStatus` collapses them onto
 * Talise's `OnrampKycStatus` ladder.
 */

// ── Bridge status enums (verbatim) ───────────────────────────────────
//   customer.status:  active | awaiting_questionnaire | awaiting_ubo |
//                     incomplete | not_started | offboarded | paused |
//                     rejected | under_review
//   kyc_link.kyc_status: not_started | incomplete | awaiting_questionnaire |
//                     awaiting_ubo | under_review | approved | rejected |
//                     paused | offboarded
export type BridgeCustomerStatus =
  | "active"
  | "awaiting_questionnaire"
  | "awaiting_ubo"
  | "incomplete"
  | "not_started"
  | "offboarded"
  | "paused"
  | "rejected"
  | "under_review";

export type BridgeKycStatus =
  | "not_started"
  | "incomplete"
  | "awaiting_questionnaire"
  | "awaiting_ubo"
  | "under_review"
  | "approved"
  | "rejected"
  | "paused"
  | "offboarded";

/** Collapse any Bridge customer/KYC status onto Talise's OnrampKycStatus. */
export function mapBridgeKycStatus(
  s: BridgeCustomerStatus | BridgeKycStatus | string | undefined
): OnrampKycStatus {
  switch (s) {
    case "active":
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "offboarded":
      return "expired";
    case "not_started":
    case undefined:
      return "unverified";
    // incomplete / under_review / awaiting_* / paused → still in flight
    default:
      return "pending";
  }
}

export type BridgeKycLink = {
  id: string;
  customer_id: string | null;
  full_name?: string;
  email: string;
  type: "individual" | "business";
  kyc_link: string;
  tos_link: string;
  kyc_status: BridgeKycStatus;
  tos_status: "pending" | "approved";
  /** Persona inquiry template (e.g. "gov_id_db"). */
  persona_inquiry_type?: string;
  rejection_reasons?: Array<{
    developer_reason?: string;
    reason?: string;
    created_at?: string;
  }>;
  created_at: string;
};

/**
 * Create a hosted KYC + ToS link. `endorsements` requests the products to
 * enable on approval (we don't need a specific one for plain on/off-ramp, but
 * Bridge accepts e.g. `["base"]`). `redirectUri` is where Bridge sends the
 * user back after completing the flow.
 */
export async function createKycLink(input: {
  email: string;
  fullName?: string;
  type?: "individual" | "business";
  redirectUri?: string;
  /** Stable Talise-owned key (e.g. `kyc-<userId>`) for idempotent retries. */
  idempotencyKey: string;
}): Promise<BridgeKycLink> {
  try {
    return await bridgeFetch<BridgeKycLink>("kyc_links", {
      method: "POST",
      idempotencyKey: input.idempotencyKey,
      body: {
        email: input.email,
        type: input.type ?? "individual",
        ...(input.fullName ? { full_name: input.fullName } : {}),
        ...(input.redirectUri ? { redirect_uri: input.redirectUri } : {}),
      },
    });
  } catch (e) {
    // Bridge returns 400 `duplicate_record` when a KYC link already exists for
    // this email — and INCLUDES the existing link in the error body. That's the
    // common case on any second "Verify" tap (Bridge keys kyc_links by email,
    // independent of our Idempotency-Key). Treat it as success and reuse the
    // existing link rather than failing the whole flow.
    const body = (e as { body?: { existing_kyc_link?: BridgeKycLink } }).body;
    if (body?.existing_kyc_link) return body.existing_kyc_link;
    throw e;
  }
}

/** Poll a KYC link's status (kyc_status + tos_status + linked customer_id). */
export async function getKycLink(id: string): Promise<BridgeKycLink> {
  return bridgeFetch<BridgeKycLink>(`kyc_links/${encodeURIComponent(id)}`);
}

/**
 * Request a hosted Terms-of-Service URL for NEW-customer creation (the direct
 * `POST /customers` path). The customer accepts ToS at the returned URL; Bridge
 * then hands back a `signed_agreement_id` via your `redirect_uri` query param
 * (or a `signedAgreementId` postMessage in a WebView), which you pass into
 * `createCustomer`. Not needed on the KYC-Links path (ToS is the `tos_link`).
 */
export async function createTosLink(input: {
  redirectUri?: string;
  idempotencyKey: string;
}): Promise<{ url: string }> {
  const res = await bridgeFetch<{ data: { url: string } }>("customers/tos_links", {
    method: "POST",
    idempotencyKey: input.idempotencyKey,
    // No body; redirect_uri is appended to the returned URL as a query param.
    body: {},
  });
  let url = res.data.url;
  if (input.redirectUri) {
    const sep = url.includes("?") ? "&" : "?";
    url = `${url}${sep}redirect_uri=${encodeURIComponent(input.redirectUri)}`;
  }
  return { url };
}

/**
 * SANDBOX ONLY: force a customer to `approved`. KYC Links don't exist in
 * sandbox, so after creating a customer you call this to simulate approval.
 * No-op-unsafe in production (Bridge returns an error there).
 */
export async function simulateKycApproval(customerId: string): Promise<void> {
  await bridgeFetch(`customers/${encodeURIComponent(customerId)}/simulate_kyc_approval`, {
    method: "POST",
    idempotencyKey: `sim-kyc-${customerId}`,
  });
}

export type BridgeCustomer = {
  id: string;
  status: BridgeCustomerStatus;
  type: "individual" | "business";
  email?: string;
  first_name?: string;
  last_name?: string;
  client_reference_id?: string;
  created_at?: string;
};

/** Fetch a customer (e.g. to refresh status after a webhook). */
export async function getCustomer(id: string): Promise<BridgeCustomer> {
  return bridgeFetch<BridgeCustomer>(`customers/${encodeURIComponent(id)}`);
}

/**
 * Direct individual-customer create. Requires a `signedAgreementId` from the
 * ToS flow before the customer can transact. Prefer `createKycLink` for the
 * hosted path; this exists for flows that collect PII in-app.
 */
export async function createCustomer(input: {
  firstName: string;
  lastName: string;
  email: string;
  signedAgreementId: string;
  /** ISO 3166-1 alpha-3 (Bridge uses 3-letter country codes). */
  residentialAddress?: {
    street_line_1: string;
    city: string;
    subdivision?: string;
    postal_code: string;
    country: string;
  };
  birthDate?: string;
  clientReferenceId?: string;
  idempotencyKey: string;
}): Promise<BridgeCustomer> {
  return bridgeFetch<BridgeCustomer>("customers", {
    method: "POST",
    idempotencyKey: input.idempotencyKey,
    body: {
      type: "individual",
      first_name: input.firstName,
      last_name: input.lastName,
      email: input.email,
      signed_agreement_id: input.signedAgreementId,
      ...(input.birthDate ? { birth_date: input.birthDate } : {}),
      ...(input.residentialAddress ? { residential_address: input.residentialAddress } : {}),
      ...(input.clientReferenceId ? { client_reference_id: input.clientReferenceId } : {}),
    },
  });
}
