import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById, ensureSchema } from "@/lib/db";
import { rateLimitAsync } from "@/lib/rate-limit";
import {
  getOnrampProvider,
  getProviderByName,
  isOnrampEnabled,
  onrampStatus,
} from "@/lib/onramp";
import { getOnrampKyc, upsertOnrampKyc } from "@/lib/onramp/kyc-store";
import { refreshBridgeKyc } from "@/lib/onramp/bridge";
import { trackDepositStarted } from "@/lib/analytics/emit";
import type { KycProfile, OnrampProviderName } from "@/lib/onramp/types";

export const runtime = "nodejs";

/**
 * POST /api/onramp/v2/session
 *
 * Return everything the client needs to fund the SIGNED-IN user's account:
 * either the hosted identity step (`kycUrl` / `tosUrl`) or the real funding
 * handles (`depositInstructions` for a Bridge virtual account, `widgetUrl` for
 * a hosted widget provider).
 *
 * ── Money-path invariants ────────────────────────────────────────────
 *  • Destination is LOCKED to `user.sui_address`. The client cannot choose
 *    where funds land, and it is not accepted from the body at all.
 *  • `amountCents` is INFORMATIONAL for bank funding (a virtual account
 *    accepts any deposit; Bridge decides what was actually received). It is
 *    never used to credit anything — the credit is Bridge minting on-chain to
 *    the user's own address, so there is no server-side balance write here and
 *    therefore no double-credit surface.
 *  • FAIL CLOSED: 404 when the feature switch is off, 503 when the provider
 *    has no credentials. The adapters return deterministic STUB data when
 *    unkeyed; a stubbed "pay here" screen would be a lie that costs a user
 *    money, so an unconfigured provider is treated as closed
 *    (`isOnrampEnabled()` already folds this in).
 *  • KYC-gated: Bridge rejects a virtual account for a non-active customer, so
 *    we check first and hand back the hosted identity step instead of letting
 *    the provider call throw a 500 at the user.
 *
 * Body: { amountCents: number, provider?: 'bridge'|'transak', sourceCurrency?: string }
 */
export async function POST(req: Request) {
  const status = onrampStatus();
  if (!isOnrampEnabled()) {
    // 404 when deliberately switched off (nothing to see), 503 when the switch
    // is on but the provider is unconfigured (a misconfiguration, not a state
    // the user can act on). Clients render "not available yet" for both.
    return status.closedReason === "provider_unconfigured"
      ? NextResponse.json(
          { error: "on-ramp provider not configured", code: "ONRAMP_UNCONFIGURED" },
          { status: 503 }
        )
      : NextResponse.json(
          { error: "on-ramp disabled", code: "ONRAMP_DISABLED" },
          { status: 404 }
        );
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }
  if (!user.sui_address) {
    return NextResponse.json(
      { error: "no wallet on this account yet", code: "NO_WALLET" },
      { status: 409 }
    );
  }

  // Anti-abuse: this route can create provider-side customers + virtual
  // accounts, so cap it per user. Generous — a funding screen may retry.
  const rl = await rateLimitAsync({
    key: `onramp-session:user:${userId}`,
    limit: 20,
    windowSec: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait a moment.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 30) } }
    );
  }

  // The onramp_kyc.kyc_link_id column arrives via ensureSchema(); apply pending
  // DDL before reading/writing it so the upsert can't 42703.
  await ensureSchema();

  let body: {
    amountCents?: number;
    provider?: OnrampProviderName;
    /** Funding fiat currency, lowercase ISO ("usd" | "eur" | "gbp"). */
    sourceCurrency?: string;
  } = {};
  try {
    const txt = await req.text();
    if (txt) body = JSON.parse(txt);
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const amountCents =
    typeof body.amountCents === "number" && Number.isFinite(body.amountCents)
      ? Math.max(0, Math.round(body.amountCents))
      : 0;
  if (amountCents <= 0) {
    return NextResponse.json(
      { error: "amountCents must be > 0" },
      { status: 400 }
    );
  }

  const provider =
    body.provider === "bridge" || body.provider === "transak"
      ? getProviderByName(body.provider)
      : getOnrampProvider();

  // Resolve / create the provider customer id. Reuse the persisted one if we
  // have it; otherwise create it from a profile DERIVED FROM THE SESSION (the
  // client never supplies PII the server already holds).
  const existing = await getOnrampKyc(userId);
  let providerCustomerId = existing?.providerCustomerId ?? null;
  let kycLinkId = existing?.kycLinkId ?? null;

  if (!providerCustomerId) {
    const parts = (user.name ?? "").trim().split(/\s+/).filter(Boolean);
    const profile: KycProfile = {
      firstName: parts[0] ?? "",
      lastName: parts.slice(1).join(" "),
      email: (user.email ?? "").toLowerCase(),
      country: (user.country ?? "").toUpperCase(),
    };
    if (!profile.email) {
      return NextResponse.json(
        {
          error: "Add an email to your account to start funding.",
          code: "EMAIL_REQUIRED",
        },
        { status: 400 }
      );
    }

    let customer;
    try {
      customer = await provider.createOrUpdateCustomer(profile);
    } catch (e) {
      return providerFailure("createOrUpdateCustomer", userId, e);
    }
    providerCustomerId = customer.providerCustomerId;
    kycLinkId = customer.kycLinkId ?? null;
    // Persist BOTH handles: webhooks arrive keyed on the kyc_link id before a
    // customer id exists, and the reconciliation query matches either column.
    await upsertOnrampKyc(userId, {
      provider: provider.name,
      providerCustomerId: customer.providerCustomerId,
      kycLinkId,
      status: customer.status,
      country: profile.country,
      dailyLimitCents: customer.dailyLimitCents ?? null,
      monthlyLimitCents: customer.monthlyLimitCents ?? null,
    });

    // A fresh Bridge customer must clear hosted KYC + ToS before it can be
    // issued a virtual account. Hand the client the identity step; it retries
    // this route once the user is verified.
    if (customer.kycUrl || customer.tosUrl) {
      return NextResponse.json({
        provider: provider.name,
        kycRequired: true,
        status: customer.status,
        kycUrl: customer.kycUrl,
        tosUrl: customer.tosUrl,
      });
    }
  }

  // Bridge only: re-check identity state LIVE before asking for a virtual
  // account. Webhooks don't always reach us (never on localhost), and Bridge
  // hard-rejects virtual accounts for non-active customers — without this the
  // user would get an opaque 500 on the funding screen.
  if (provider.name === "bridge") {
    let kyc;
    try {
      kyc = await refreshBridgeKyc({ kycLinkId, providerCustomerId });
    } catch (e) {
      return providerFailure("refreshBridgeKyc", userId, e);
    }
    // Keep the cached record honest (this row also gates the cash-out path).
    await upsertOnrampKyc(userId, {
      provider: "bridge",
      providerCustomerId: kyc.customerId ?? providerCustomerId,
      kycLinkId,
      status: kyc.status,
    });
    if (kyc.status !== "approved" || !kyc.customerId) {
      return NextResponse.json({
        provider: "bridge",
        kycRequired: true,
        status: kyc.status,
        kycUrl: kyc.kycUrl,
        tosUrl: kyc.tosUrl,
      });
    }
    // The real customer id is authoritative once KYC completes.
    providerCustomerId = kyc.customerId;
  }

  let session;
  try {
    session = await provider.createOnrampSession({
      providerCustomerId,
      amountCents,
      destinationAddress: user.sui_address, // LOCKED to the signed-in user
      deliverAsset: provider.deliverAsset,
      sourceCurrency: body.sourceCurrency?.toLowerCase(),
    });
  } catch (e) {
    return providerFailure("createOnrampSession", userId, e);
  }

  // GROWTH: the funding handles now exist (virtual account / hosted widget), so
  // the deposit funnel genuinely started. Deliberately NOT `funded`: there is no
  // server-side credit on this path at all — the provider mints on-chain to the
  // user's own address — so "money in" is observed from the on-chain ledger, not
  // from here (see deriveEvents in lib/analytics/growth-ingest.ts). The amount is
  // BANDED, and no deposit instructions / account numbers are passed on.
  trackDepositStarted(userId, {
    usd: amountCents / 100,
    provider: provider.name,
    currency: body.sourceCurrency?.toUpperCase(),
  });

  return NextResponse.json(session);
}

/**
 * Collapse any provider/transport error into a clean 502 with a stable code.
 * The provider's raw message can carry applicant detail, so it is logged
 * server-side only and never echoed to the client.
 */
function providerFailure(stage: string, userId: number, e: unknown) {
  const err = e as { message?: string; status?: number; code?: string };
  const detail = [err.code, err.status, err.message].filter(Boolean).join(" · ");
  console.error(`[onramp/v2/session] ${stage} failed user=${userId}: ${detail}`);
  return NextResponse.json(
    {
      error: "Couldn't set up funding right now. Please try again.",
      code: "PROVIDER_ERROR",
    },
    { status: 502 }
  );
}
