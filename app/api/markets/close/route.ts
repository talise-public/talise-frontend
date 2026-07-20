import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { rateLimitAsync } from "@/lib/rate-limit";
import { WATERX_ENABLED, WATERX_LOCAL_SIGN, localSigner, buildCloseTx, settle, friendlyPerpError } from "@/lib/waterx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/markets/close, close a perp position at market.
 * Body: { ticker, accountId, positionId, isLong }
 * Local mode executes with the dev key; otherwise returns sponsor-ready bytes.
 */
export async function POST(req: Request) {
  if (!WATERX_ENABLED) return NextResponse.json({ error: "Perps aren't enabled.", code: "PERPS_DISABLED" }, { status: 503 });

  let sender: string;
  if (WATERX_LOCAL_SIGN && localSigner()) {
    sender = localSigner()!.toSuiAddress();
  } else {
    const userId = await readEntryIdFromRequest(req);
    if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
    const denied = await denyUnlessAppApproved(userId);
    if (denied) return denied;
    const rl = await rateLimitAsync({ key: `perp:close:${userId}`, limit: 60, windowSec: 3600 });
    if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } });
    const user = await userById(userId);
    if (!user?.sui_address) return NextResponse.json({ error: "user not found" }, { status: 404 });
    sender = user.sui_address;
  }

  let b: { ticker?: string; accountId?: string; positionId?: string; isLong?: boolean };
  try { b = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const ticker = String(b.ticker ?? "");
  const accountId = String(b.accountId ?? "");
  const positionId = String(b.positionId ?? "");
  if (!ticker || !accountId || !positionId) {
    return NextResponse.json({ error: "ticker, accountId, positionId required" }, { status: 400 });
  }

  try {
    const { tx, feeUsd } = await buildCloseTx(ticker, accountId, positionId, b.isLong ?? true, sender);
    const result = await settle(tx, sender);
    return NextResponse.json({ ...result, ticker, positionId, feeUsd });
  } catch (err) {
    const msg = (err as Error).message ?? "failed";
    console.warn(`[perp/close] failed: ${msg}`);
    return NextResponse.json({ error: friendlyPerpError(msg), raw: msg }, { status: 500 });
  }
}
