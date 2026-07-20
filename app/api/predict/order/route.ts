import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { rateLimitAsync } from "@/lib/rate-limit";
import { WATERX_ENABLED, WATERX_LOCAL_SIGN, localSigner, getStoredAccount, settle } from "@/lib/waterx";
import { buildBetTx } from "@/lib/waterx-predict";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/predict/order, buy YES/NO shares on a prediction market.
 * Body: { marketId, selection: "YES"|"NO", betUsd, price }
 * Sweeps the user's USDsui → CREDIT and places the order (shared waterx_account).
 */
export async function POST(req: Request) {
  if (!WATERX_ENABLED) return NextResponse.json({ error: "Prediction isn't enabled.", code: "PERPS_DISABLED" }, { status: 503 });

  let sender: string;
  let userId: number | null = null;
  if (WATERX_LOCAL_SIGN && localSigner()) {
    sender = localSigner()!.toSuiAddress();
  } else {
    userId = await readEntryIdFromRequest(req);
    if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
    const denied = await denyUnlessAppApproved(userId);
    if (denied) return denied;
    const rl = await rateLimitAsync({ key: `predict:order:${userId}`, limit: 60, windowSec: 3600 });
    if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } });
    const user = await userById(userId);
    if (!user?.sui_address) return NextResponse.json({ error: "user not found" }, { status: 404 });
    sender = user.sui_address;
  }

  const accountId = userId != null ? await getStoredAccount(userId) : null;
  if (!accountId) return NextResponse.json({ error: "No trading account, create one in Markets first.", code: "NO_ACCOUNT" }, { status: 409 });

  let b: { marketId?: string; selection?: string; betUsd?: number; price?: number };
  try { b = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const marketId = String(b.marketId ?? "");
  const selection = b.selection === "NO" ? "NO" : "YES";
  const betUsd = Number(b.betUsd ?? 0);
  const price = Number(b.price ?? 0);
  if (!marketId || betUsd <= 0 || price <= 0) {
    return NextResponse.json({ error: "marketId, betUsd, price required" }, { status: 400 });
  }

  try {
    const tx = await buildBetTx(accountId, marketId, selection, betUsd, price);
    const result = await settle(tx, sender);
    return NextResponse.json({ ...result, marketId, selection, betUsd });
  } catch (err) {
    const msg = (err as Error).message ?? "failed";
    console.warn(`[predict/order] failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
