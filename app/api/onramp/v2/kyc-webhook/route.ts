import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getProviderByName } from "@/lib/onramp";
import { upsertOnrampKyc } from "@/lib/onramp/kyc-store";
import type { OnrampProviderName } from "@/lib/onramp/types";

export const runtime = "nodejs";

/**
 * POST /api/onramp/v2/kyc-webhook?provider=bridge|transak
 *
 * Verify + parse a provider KYC/status webhook and write the result through
 * to the `onramp_kyc` record. The DB write is GUARDED: if the migration
 * hasn't been applied the upsert no-ops gracefully (kyc-store logs a clear
 * warning) so this NEVER throws in dev.
 *
 * Reconciles the provider customer id → internal user id via the persisted
 * `onramp_kyc.provider_customer_id`. If we can't resolve a user we still ack
 * (200) so the provider doesn't retry forever, the event is logged.
 *
 * Distinct path from the existing Stripe webhook (/api/onramp/webhook); both
 * coexist. Lives behind no feature flag on purpose: a provider may deliver a
 * late webhook even after the flag is toggled, and verification fails closed
 * when a secret is configured but the signature is bad.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const providerName = (url.searchParams.get("provider") ||
    "bridge") as OnrampProviderName;
  const provider =
    providerName === "transak"
      ? getProviderByName("transak")
      : getProviderByName("bridge");

  const rawBody = await req.text();

  let event;
  try {
    event = await provider.verifyWebhook(rawBody, req.headers);
  } catch (err) {
    console.error("[onramp/v2/kyc-webhook] verify failed", {
      provider: providerName,
      error: (err as Error).message,
    });
    return NextResponse.json({ error: "verify failed" }, { status: 400 });
  }

  // Fail closed IN PRODUCTION. This block previously only logged and then fell
  // through to the write below, so an unsigned POST naming a known
  // provider_customer_id / kyc_link_id could forge a KYC verdict (status, tier,
  // daily/monthly limits) for that user. Those fields are trusted downstream:
  // /api/offramp/bridge/cashout-address short-circuits its live Bridge re-check
  // when the cached status is "approved", and /api/onramp/v2/requirements reads
  // `tier` straight from this table. Mirrors the fail-closed posture of the
  // sibling eKYC webhook (app/api/kyc/webhook/route.ts).
  //
  // Dev/preview keeps the unsigned path so local testing works without a
  // provider secret, matching the original documented intent.
  if (!event.verified) {
    if (process.env.NODE_ENV === "production") {
      console.error("[onramp/v2/kyc-webhook] REJECTED unverified event", {
        provider: providerName,
        kind: event.kind,
      });
      return NextResponse.json({ error: "unverified" }, { status: 401 });
    }
    console.warn(
      "[onramp/v2/kyc-webhook] accepting UNVERIFIED event in dev only (no/invalid sig)",
      { provider: providerName, kind: event.kind }
    );
  }

  if (!event.providerCustomerId) {
    console.log("[onramp/v2/kyc-webhook] no customer id on event, ack", {
      provider: providerName,
      kind: event.kind,
    });
    return NextResponse.json({ received: true });
  }

  // Resolve internal user id from the persisted provider customer id.
  // Guarded: if onramp_kyc is absent this lookup throws 42P01 → treat as
  // "no mapping yet" and ack.
  let userId: number | null = null;
  try {
    const r = await db().execute({
      // Match EITHER column: kyc_link events carry the link id before a
      // customer id exists, so resolve on provider_customer_id OR kyc_link_id.
      sql: "SELECT user_id FROM onramp_kyc WHERE provider_customer_id = ? OR kyc_link_id = ? LIMIT 1",
      args: [event.providerCustomerId, event.providerCustomerId],
    });
    const row = r.rows[0] as { user_id?: number } | undefined;
    userId = typeof row?.user_id === "number" ? row.user_id : null;
  } catch (err) {
    console.warn(
      "[onramp/v2/kyc-webhook] onramp_kyc lookup no-op (table likely absent)",
      { error: (err as Error).message }
    );
    return NextResponse.json({ received: true });
  }

  if (userId == null) {
    console.log("[onramp/v2/kyc-webhook] unknown customer, ack", {
      providerCustomerId: event.providerCustomerId,
    });
    return NextResponse.json({ received: true });
  }

  // Write through. No-ops gracefully if the table doesn't exist.
  const wrote = await upsertOnrampKyc(userId, {
    provider: event.provider,
    providerCustomerId: event.providerCustomerId,
    status: event.status,
    tier: event.tier,
    country: event.country ?? null,
    dailyLimitCents: event.dailyLimitCents ?? null,
    monthlyLimitCents: event.monthlyLimitCents ?? null,
  });

  return NextResponse.json({ received: true, persisted: wrote });
}
