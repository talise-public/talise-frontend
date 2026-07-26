import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { rateLimitAsync } from "@/lib/rate-limit";
import { redeemSku, RedeemError } from "@/lib/rewards/redeem";

export const runtime = "nodejs";

/**
 * POST /api/rewards/redeem
 *
 * Body: `{ sku: string }`
 *
 * Spends the user's points against a catalogue SKU. Returns the new
 * pointsTotal + the created redemption row. All validation lives in
 * lib/rewards/redeem.ts → redeemSku; this route is just the HTTP
 * envelope + auth.
 *
 * Error codes (in the JSON body's `code` field):
 *   unknown_sku        404
 *   sku_disabled       410
 *   user_not_found     404
 *   insufficient_points 402
 *   debounced          429
 *   already_active     409
 */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // This endpoint spends points for REAL outbound value (the catalogue's
  // `airtime_ngn_500` is an operator-fulfilled ₦500 mobile top-up), but had
  // neither the private-beta guard nor any rate limit. `redeemSku` checks
  // affordability with a plain read and then debits unconditionally
  // (lib/rewards/redeem.ts:159-166 → lib/db.ts:2135), so concurrent requests
  // each create a payout obligation and drive `points_total` negative.
  //
  // The real fix is an atomic conditional debit (see AUDIT-2026-07-24 H6); this
  // guard bounds the blast radius in the meantime and brings the route in line
  // with every other value-moving endpoint. The cap is deliberately tight —
  // redemption is a rare, deliberate user action, not a hot path.
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  const rl = await rateLimitAsync({
    key: `rewards-redeem:user:${userId}`,
    limit: 5,
    windowSec: 3600,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", code: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }

  let body: { sku?: unknown };
  try {
    body = (await req.json()) as { sku?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const sku = typeof body.sku === "string" ? body.sku.trim() : "";
  if (!sku) {
    return NextResponse.json(
      { error: "sku required", code: "missing_sku" },
      { status: 400 }
    );
  }

  try {
    const result = await redeemSku({ userId, sku });
    return NextResponse.json({
      ok: true,
      pointsTotal: result.newPointsTotal,
      redemption: {
        id: String(result.redemption.id),
        sku: result.redemption.sku,
        pointsSpent: result.redemption.points_spent,
        status: result.redemption.status,
        createdAt: new Date(result.redemption.created_at).toISOString(),
        fulfilledAt: result.redemption.fulfilled_at
          ? new Date(result.redemption.fulfilled_at).toISOString()
          : null,
        metadata: result.redemption.metadata
          ? JSON.parse(result.redemption.metadata)
          : null,
      },
    });
  } catch (err) {
    if (err instanceof RedeemError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    return NextResponse.json(
      { error: (err as Error).message, code: "internal_error" },
      { status: 500 }
    );
  }
}
