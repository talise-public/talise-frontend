import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { getOnrampProvider, isOnrampEnabled } from "@/lib/onramp";
import { getOnrampKyc } from "@/lib/onramp/kyc-store";
import type { OnrampKycTier } from "@/lib/onramp/types";

export const runtime = "nodejs";

/**
 * POST /api/onramp/v2/requirements
 *
 * Quote-gated KYC: given { amountCents, country }, return the minimum tier
 * the purchase needs and the fields still missing from the user's current
 * tier. Read-only — touches no money path. Dormant unless the on-ramp
 * feature flag is on.
 *
 * Namespaced under /v2 so it sits ALONGSIDE the existing Stripe-based
 * /api/onramp/session + /api/onramp/webhook routes without modifying them.
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

  let body: { amountCents?: number; country?: string } = {};
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
  const country = (body.country || user.country || "").trim();
  if (!country) {
    return NextResponse.json(
      { error: "country is required (none on profile)" },
      { status: 400 }
    );
  }

  // Current on-ramp tier from the (possibly-absent) onramp_kyc table.
  const existing = await getOnrampKyc(userId);
  const currentTier: OnrampKycTier = existing?.tier ?? "none";

  const provider = getOnrampProvider();
  const result = await provider.getRequirements({
    amountCents,
    country,
    currentTier,
  });

  return NextResponse.json({
    provider: provider.name,
    deliverAsset: provider.deliverAsset,
    currentTier,
    ...result,
  });
}
