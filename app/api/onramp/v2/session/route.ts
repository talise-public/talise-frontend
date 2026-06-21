import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import {
  getOnrampProvider,
  getProviderByName,
  isOnrampEnabled,
} from "@/lib/onramp";
import { getOnrampKyc, upsertOnrampKyc } from "@/lib/onramp/kyc-store";
import type {
  KycProfile,
  OnrampProviderName,
} from "@/lib/onramp/types";

export const runtime = "nodejs";

/**
 * POST /api/onramp/v2/session
 *
 * Create a provider-agnostic on-ramp session. Returns the (stub) widget URL /
 * client secret. The destination is LOCKED to the authenticated user's own
 * Sui address — the client never chooses where funds land.
 *
 * This does NOT move money or touch any balance/limit path: with no API key
 * configured the selected adapter returns a stub URL. Dormant unless the
 * on-ramp feature flag is on. Lives alongside the existing Stripe
 * /api/onramp/session route, not replacing it.
 *
 * Body: { amountCents: number, provider?: 'bridge'|'transak', profile?: KycProfile }
 */
export async function POST(req: Request) {
  if (!isOnrampEnabled()) {
    return NextResponse.json({ error: "on-ramp disabled" }, { status: 404 });
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: {
    amountCents?: number;
    provider?: OnrampProviderName;
    profile?: KycProfile;
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
  // have it; otherwise create from the supplied profile (stub when no key).
  const existing = await getOnrampKyc(userId);
  let providerCustomerId = existing?.providerCustomerId ?? null;
  // Bridge: the hosted KYC URL returned when we first create the customer.
  // Surfaced to the client so it can redirect the user to finish identity
  // verification before (or alongside) showing funding instructions.
  let kycUrl: string | undefined;

  if (!providerCustomerId) {
    let profile: KycProfile | undefined = body.profile;
    // Widget-KYC providers (Transak) verify identity inside their hosted
    // widget, so the client need not collect a profile — derive a minimal one
    // from the authenticated user just to mint a stable partner reference.
    // Bridge runs hosted KYC from just an email + name, so we likewise derive
    // a minimal profile from the signed-in user rather than make the client
    // re-collect PII the server already holds.
    if (!profile && (provider.widgetCollectsKyc || provider.name === "bridge")) {
      const parts = (user.name ?? "").trim().split(/\s+/).filter(Boolean);
      profile = {
        firstName: parts[0] ?? "",
        lastName: parts.slice(1).join(" "),
        email: (user.email ?? "").toLowerCase(),
        country: (user.country ?? "").toUpperCase(),
      } as KycProfile;
    }
    if (!profile) {
      return NextResponse.json(
        { error: "no provider customer yet — supply `profile` to create one" },
        { status: 400 }
      );
    }
    const customer = await provider.createOrUpdateCustomer(profile);
    providerCustomerId = customer.providerCustomerId;
    kycUrl = customer.kycUrl;
    // Best-effort persist (no-ops if the migration isn't applied).
    await upsertOnrampKyc(userId, {
      provider: provider.name,
      providerCustomerId: customer.providerCustomerId,
      status: customer.status,
      country: profile.country,
      dailyLimitCents: customer.dailyLimitCents ?? null,
      monthlyLimitCents: customer.monthlyLimitCents ?? null,
    });
  }

  // If we just created the customer and it needs hosted KYC, return the KYC
  // URL only. A non-active customer can't be issued a virtual account (Bridge
  // rejects it), so attempting the session here would error — the client shows
  // the verify-identity step first, then retries once the customer is active.
  if (kycUrl) {
    return NextResponse.json({ provider: provider.name, kycUrl });
  }

  const session = await provider.createOnrampSession({
    providerCustomerId,
    amountCents,
    destinationAddress: user.sui_address, // LOCKED to the signed-in user
    deliverAsset: provider.deliverAsset,
    sourceCurrency: body.sourceCurrency?.toLowerCase(),
  });

  // `kycUrl` (when present) lets the client send the user through hosted KYC;
  // `depositInstructions` / `widgetUrl` come from the session itself.
  return NextResponse.json(kycUrl ? { ...session, kycUrl } : session);
}
