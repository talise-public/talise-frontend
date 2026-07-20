import "server-only";

import type { KycTier } from "@/lib/kyc";

/**
 * eKYC provider adapter (cross-border master plan §7).
 *
 * A thin, provider-agnostic interface shaped after the request/response
 * model that Sumsub and Persona both expose: you submit an applicant +
 * the level/template you want them screened against, and you get back a
 * verification reference plus a (usually pending) status that later
 * resolves via webhook.
 *
 * THIS IS A MOCK. `verifyIdentity()` makes NO network call to any live
 * provider. It deterministically derives a stable verdict + reference
 * from the input so the rest of the system (the /api/kyc POST route,
 * the kyc_upgrade_intents log) can be wired up and tested end-to-end
 * before a real Sumsub/Persona key is plumbed in. Swap the body of
 * `MockEkycProvider.verifyIdentity` for a real `fetch` to go live, the
 * interface is the contract the route depends on, not the implementation.
 */

export type EkycStatus = "pending" | "approved" | "rejected";

export type EkycProviderName = "sumsub" | "persona" | "mock";

/**
 * What the caller hands the provider. Mirrors the union of fields
 * Sumsub's `applicants` and Persona's `inquiries` accept; everything
 * except `userId` and `targetTier` is optional because tier 1 needs far
 * less than tier 3.
 */
export type VerifyIdentityInput = {
  /** Internal Talise user id, becomes the provider's externalUserId. */
  userId: number;
  /** Tier the user is trying to reach; selects the screening level. */
  targetTier: KycTier;
  /** Optional applicant PII the client collected up front. */
  email?: string | null;
  fullName?: string | null;
  country?: string | null;
  /** Document references the client already uploaded, if any. */
  documentRefs?: ReadonlyArray<string> | null;
};

/**
 * What the provider returns. `ref` is the opaque provider-side id we
 * persist on the intent row and later reconcile against the webhook.
 */
export type VerifyIdentityResult = {
  status: EkycStatus;
  ref: string;
  provider: EkycProviderName;
};

/** The contract every provider implementation must satisfy. */
export interface EkycProvider {
  readonly name: EkycProviderName;
  verifyIdentity(input: VerifyIdentityInput): Promise<VerifyIdentityResult>;
}

/**
 * Deterministic mock. Generates a stable-looking reference and a verdict
 * that's `pending` for the common case (most submissions sit in review),
 * with a couple of deterministic carve-outs so a test harness can drive
 * the approved/rejected branches without randomness:
 *
 *   • no document refs supplied for a tier that needs ID  → rejected
 *     (mirrors a real provider bouncing an empty applicant)
 *   • otherwise                                            → pending
 *
 * No live call, no secrets, no side effects beyond computing a string.
 */
export class MockEkycProvider implements EkycProvider {
  readonly name: EkycProviderName = "mock";

  async verifyIdentity(
    input: VerifyIdentityInput
  ): Promise<VerifyIdentityResult> {
    const ref = mockRef(input.userId, input.targetTier);

    // Tier 0 needs nothing verified; treat as instantly fine.
    if (input.targetTier <= 0) {
      return { status: "approved", ref, provider: this.name };
    }

    // Any tier ≥ 1 needs at least one identity document. A submission
    // with none is something a real provider would reject outright.
    const hasDocs = (input.documentRefs?.length ?? 0) > 0;
    if (!hasDocs) {
      return { status: "rejected", ref, provider: this.name };
    }

    // Everything else lands in manual review, the realistic default.
    return { status: "pending", ref, provider: this.name };
  }
}

/**
 * Build a stable-looking reference id. Real providers return their own
 * (e.g. Sumsub `applicantId`); we synthesize one so the persisted
 * `ekyc_ref` has the same shape and uniqueness characteristics.
 */
function mockRef(userId: number, targetTier: KycTier): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `mock_${userId}_t${targetTier}_${Date.now().toString(36)}_${rand}`;
}

/**
 * Resolve the active provider. Today this is always the mock; when a real
 * key is configured the factory can branch on env (e.g. SUMSUB_API_KEY)
 * and return the live adapter instead. Callers depend only on the
 * `EkycProvider` interface, so flipping this is a one-line change.
 */
export function getEkycProvider(): EkycProvider {
  return new MockEkycProvider();
}

/**
 * Convenience wrapper used by the route: resolves the provider and runs
 * the check in one call.
 */
export function verifyIdentity(
  input: VerifyIdentityInput
): Promise<VerifyIdentityResult> {
  return getEkycProvider().verifyIdentity(input);
}
