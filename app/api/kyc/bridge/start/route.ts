import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById, ensureSchema } from "@/lib/db";
import { bridgeAdapter } from "@/lib/onramp/bridge";
import { upsertOnrampKyc } from "@/lib/onramp/kyc-store";
import { bridgeConfigured } from "@/lib/bridge/client";
import { rateLimitAsync } from "@/lib/rate-limit";
import type { KycProfile } from "@/lib/onramp/types";

export const runtime = "nodejs";

/**
 * POST /api/kyc/bridge/start
 *
 * Begin (or resume) Bridge hosted KYC for the signed-in user. Idempotent:
 * Bridge returns the same KYC link for the same email within 24h, so re-calling
 * is safe (the client may poll start → status). Derives a minimal KycProfile
 * from the authenticated user — the client never supplies PII the server holds.
 *
 * 503 when Bridge isn't configured (env-gated, like every Talise ramp partner).
 * Does NOT move money or touch any balance/limit path.
 */
export async function POST(req: Request) {
  if (!bridgeConfigured()) {
    return NextResponse.json({ error: "bridge_disabled" }, { status: 503 });
  }
  // Apply pending schema (the onramp_kyc.kyc_link_id column) before we read/
  // write it — otherwise the upsert throws undefined_column (42703) and 502s.
  await ensureSchema();
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  // Anti-abuse: cap KYC-link creation per user. Generous (verification is a
  // handful of taps), but stops a loop from spamming Bridge's kyc_links API.
  const rl = await rateLimitAsync({
    key: `kyc-start:user:${userId}`,
    limit: 12,
    windowSec: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait a moment and try again.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 30) } }
    );
  }

  // Derive a minimal profile from the signed-in user (same shape as the
  // onramp v2 session route): split name into first/last, normalize email +
  // country. Bridge runs hosted KYC from just an email + name.
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
        error: "Add an email to your account to verify your identity.",
        code: "EMAIL_REQUIRED",
      },
      { status: 400 }
    );
  }

  try {
    const customer = await bridgeAdapter.createOrUpdateCustomer(profile);
    // Best-effort persist (no-ops if the migration isn't applied).
    await upsertOnrampKyc(userId, {
      provider: "bridge",
      providerCustomerId: customer.providerCustomerId,
      kycLinkId: customer.kycLinkId ?? null,
      status: customer.status,
      country: profile.country,
    });
    return NextResponse.json({
      provider: "bridge",
      status: customer.status,
      kycUrl: customer.kycUrl,
      tosUrl: customer.tosUrl,
      kycLinkId: customer.kycLinkId,
      customerId: customer.providerCustomerId,
    });
  } catch (e) {
    const err = e as { message?: string; status?: number; code?: string };
    const detail = [err.code, err.status, err.message].filter(Boolean).join(" · ");
    console.error(`[kyc/bridge/start] failed user=${userId}: ${detail}`);
    return NextResponse.json(
      { error: "Couldn't start verification. Please try again.", code: "BRIDGE_ERROR" },
      { status: 502 }
    );
  }
}
