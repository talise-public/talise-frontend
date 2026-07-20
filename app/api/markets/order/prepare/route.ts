import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { rateLimitAsync } from "@/lib/rate-limit";
import { WATERX_ENABLED, WATERX_LOCAL_SIGN, localSigner, buildOrderTx, settle, addActiveMarket, friendlyPerpError } from "@/lib/waterx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/markets/order/prepare, place a WaterX perp order.
 *
 * Local prototype (FEATURE_PERPS_LOCAL_SIGN): signs + executes with the dev key,
 * returns { mode:"executed", digest }. Otherwise builds a sponsor-ready PTB on
 * the Onara + zkLogin rail, returns { mode:"sponsored", bytes }.
 *
 * Body: { ticker, accountId, isLong, sizeTokens, collateralUsd, acceptablePriceUsd }
 */
export async function POST(req: Request) {
  if (!WATERX_ENABLED) {
    return NextResponse.json({ error: "Perps aren't enabled.", code: "PERPS_DISABLED" }, { status: 503 });
  }

  // Sender: dev key in local mode, else the authenticated zkLogin user.
  let sender: string;
  if (WATERX_LOCAL_SIGN && localSigner()) {
    sender = localSigner()!.toSuiAddress();
  } else {
    const userId = await readEntryIdFromRequest(req);
    if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
    const denied = await denyUnlessAppApproved(userId);
    if (denied) return denied;
    const rl = await rateLimitAsync({ key: `perp:order:${userId}`, limit: 60, windowSec: 3600 });
    if (!rl.ok) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } });
    }
    const user = await userById(userId);
    if (!user?.sui_address) return NextResponse.json({ error: "user not found" }, { status: 404 });
    sender = user.sui_address;
  }

  let b: {
    ticker?: string; accountId?: string; isLong?: boolean;
    sizeTokens?: number; collateralUsd?: number; acceptablePriceUsd?: number;
    tpPriceUsd?: number; slPriceUsd?: number;
  };
  try { b = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const ticker = String(b.ticker ?? "").toUpperCase();
  const accountId = String(b.accountId ?? "");
  const sizeTokens = Number(b.sizeTokens ?? 0);
  const collateralUsd = Number(b.collateralUsd ?? 0);
  const acceptablePriceUsd = Number(b.acceptablePriceUsd ?? 0);
  const tpPriceUsd = b.tpPriceUsd && b.tpPriceUsd > 0 ? Number(b.tpPriceUsd) : undefined;
  const slPriceUsd = b.slPriceUsd && b.slPriceUsd > 0 ? Number(b.slPriceUsd) : undefined;
  if (!ticker || !accountId || sizeTokens <= 0 || collateralUsd <= 0 || acceptablePriceUsd <= 0) {
    return NextResponse.json({ error: "ticker, accountId, sizeTokens, collateralUsd, acceptablePriceUsd required" }, { status: 400 });
  }

  try {
    const tx = await buildOrderTx({ ticker, accountId, isLong: b.isLong ?? true, sizeTokens, collateralUsd, acceptablePriceUsd, tpPriceUsd, slPriceUsd });
    const result = await settle(tx, sender);
    // Remember this market so the next account read scans it and the new
    // position shows up immediately (best-effort, never blocks the response).
    void addActiveMarket(accountId, ticker);
    return NextResponse.json({ ...result, venue: "WaterX", ticker, side: (b.isLong ?? true) ? "long" : "short" });
  } catch (err) {
    const msg = (err as Error).message ?? "failed";
    console.warn(`[perp/order] failed: ${msg}`);
    return NextResponse.json({ error: friendlyPerpError(msg), raw: msg }, { status: 500 });
  }
}
