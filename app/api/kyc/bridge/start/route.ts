import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById, ensureSchema, updateUserEmail } from "@/lib/db";
import { isPrivateRelayEmail, isUsableRealEmail } from "@/lib/email-address";
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
 * from the authenticated user, the client never supplies PII the server holds.
 *
 * 503 when Bridge isn't configured (env-gated, like every Talise ramp partner).
 * Does NOT move money or touch any balance/limit path.
 */
export async function POST(req: Request) {
  if (!bridgeConfigured()) {
    return NextResponse.json({ error: "bridge_disabled" }, { status: 503 });
  }
  // Apply pending schema (the onramp_kyc.kyc_link_id column) before we read/
  // write it, otherwise the upsert throws undefined_column (42703) and 502s.
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
  let email = (user.email ?? "").toLowerCase();

  // Apple "Hide My Email" hands us a `@privaterelay.appleid.com` relay address
  // that Bridge KYC can never verify (these pile up as "Not started / Unknown"
  // customers and can never cash out). Apple always offers "Hide My Email" and
  // it can't be disabled, so instead of sending a doomed relay address to
  // Bridge, we require the user to supply a real email once, persist it, and
  // verify against that. The client prompts for it and re-calls with { email }.
  if (isPrivateRelayEmail(email)) {
    const body = (await req.json().catch(() => null)) as { email?: unknown } | null;
    const provided = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!provided) {
      return NextResponse.json(
        {
          error:
            "Apple hid your email, so we can't verify it. Add a real email to verify your identity and cash out.",
          code: "REAL_EMAIL_REQUIRED",
        },
        { status: 409 }
      );
    }
    if (!isUsableRealEmail(provided)) {
      return NextResponse.json(
        {
          error: "Enter a valid personal email (not an Apple private-relay address).",
          code: "REAL_EMAIL_INVALID",
        },
        { status: 400 }
      );
    }
    await updateUserEmail(userId, provided);
    email = provided;
  }

  const profile: KycProfile = {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
    email,
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
