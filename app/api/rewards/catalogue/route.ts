import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { visibleCatalogue } from "@/lib/rewards/catalogue";

export const runtime = "nodejs";

/**
 * GET /api/rewards/catalogue
 *
 * Returns the user-visible catalogue (enabled SKUs only) + the user's
 * current `pointsTotal` so the iOS Rewards screen can render
 * affordability ("Redeem" vs "X pts needed") without a second round-trip.
 *
 * Tier gates are evaluated server-side: SKUs with a `minTier` higher
 * than the user's current tier are returned but marked `locked: true`.
 * iOS renders them at reduced opacity with the tier-required hint.
 *
 * The catalogue itself is hardcoded in lib/rewards/catalogue.ts — no
 * DB read, the only DB hit is the user row for `pointsTotal`.
 */
export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const pointsTotal = Number(user.points_total ?? 0) || 0;
  const items = visibleCatalogue().map((s) => ({
    sku: s.sku,
    label: s.label,
    description: s.description,
    pointsCost: s.pointsCost,
    kind: s.kind,
    icon: s.icon ?? null,
    minTier: s.minTier ?? null,
    stackable: s.stackable ?? false,
    durationMs: s.durationMs ?? null,
    // Affordability hint — iOS could derive this client-side but having
    // the server compute it keeps the rendering logic dumb on the
    // mobile side (so future server-side promos like a Black Friday
    // discount work without an iOS release).
    canAfford: s.pointsCost <= pointsTotal,
  }));

  return NextResponse.json({
    pointsTotal,
    items,
  });
}
