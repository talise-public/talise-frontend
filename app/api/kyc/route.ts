import { NextResponse } from "next/server";
import { readSessionEntryId } from "@/lib/session";
import { db, ensureSchema } from "@/lib/db";
import {
  getUserTier,
  isKycTier,
  limitsForTier,
  normalizeTier,
  TIER_LIMITS,
  type KycTier,
} from "@/lib/kyc";
import { verifyIdentity } from "@/lib/ekyc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * KYC tier engine HTTP surface (cross-border master plan §7).
 *
 * GET  /api/kyc
 *   → { tier, limits, allTiers }
 *   The caller's current tier + its limit envelope, plus the full tier
 *   table so the client can render the "upgrade to unlock" ladder.
 *
 * POST /api/kyc
 *   body: { targetTier: 1|2|3, fullName?, country?, documentRefs?: string[] }
 *   → { ok, intentId, requestedTier, ekyc: { status, ref, provider } }
 *   Records a tier-upgrade INTENT and kicks off the (mock) eKYC check.
 *   This NEVER mutates users.kyc_tier, promotion is a separate reviewed
 *   write (lib/kyc.ts setUserTier), typically driven by the provider's
 *   approval webhook. So a self-service POST can't grant itself a higher
 *   limit.
 *
 * Both verbs are session-gated via readSessionEntryId; 401 with no
 * session. This route is intentionally NOT wired into the send path.
 */

export async function GET() {
  const userId = await readSessionEntryId();
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const tier = await getUserTier(userId);
  return NextResponse.json({
    tier,
    limits: limitsForTier(tier),
    allTiers: Object.values(TIER_LIMITS),
  });
}

export async function POST(req: Request) {
  const userId = await readSessionEntryId();
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  let body: {
    targetTier?: unknown;
    fullName?: unknown;
    country?: unknown;
    documentRefs?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Validate the requested tier: must be a modelled tier and strictly
  // above the current one (you don't "upgrade" to where you already are
  // or below it).
  const requestedTier = normalizeTier(body.targetTier);
  if (!isKycTier(body.targetTier) || requestedTier === 0) {
    return NextResponse.json(
      { error: "targetTier must be 1, 2, or 3", code: "bad_target_tier" },
      { status: 400 }
    );
  }
  const currentTier = await getUserTier(userId);
  if (requestedTier <= currentTier) {
    return NextResponse.json(
      {
        error: `already at tier ${currentTier}`,
        code: "not_an_upgrade",
        tier: currentTier,
      },
      { status: 409 }
    );
  }

  const fullName =
    typeof body.fullName === "string" ? body.fullName.trim() || null : null;
  const country =
    typeof body.country === "string" ? body.country.trim() || null : null;
  const documentRefs = Array.isArray(body.documentRefs)
    ? body.documentRefs.filter((d): d is string => typeof d === "string")
    : null;

  // Kick off the (mock) eKYC check. No live network call.
  const ekyc = await verifyIdentity({
    userId,
    targetTier: requestedTier as KycTier,
    fullName,
    country,
    documentRefs,
  });

  // Record the intent. Append-only; does not touch users.kyc_tier.
  await ensureSchema();
  const inserted = await db().execute({
    sql: `INSERT INTO kyc_upgrade_intents
      (user_id, from_tier, requested_tier, ekyc_provider, ekyc_ref, ekyc_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING id`,
    args: [
      userId,
      currentTier,
      requestedTier,
      ekyc.provider,
      ekyc.ref,
      ekyc.status,
      Date.now(),
    ],
  });
  const intentId = inserted.rows[0]?.id;

  return NextResponse.json({
    ok: true,
    intentId: intentId != null ? String(intentId) : null,
    fromTier: currentTier,
    requestedTier,
    ekyc: {
      status: ekyc.status,
      ref: ekyc.ref,
      provider: ekyc.provider,
    },
  });
}
