import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { rateLimitAsync } from "@/lib/rate-limit";
import { WATERX_ENABLED, WATERX_LOCAL_SIGN, localSigner, getStoredAccount, settle } from "@/lib/waterx";
import { buildClaimTx } from "@/lib/waterx-predict";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/predict/claim, claim winnings from resolved positions. Body: { positionIds: string[] } */
export async function POST(req: Request) {
  if (!WATERX_ENABLED) return NextResponse.json({ error: "disabled", code: "PERPS_DISABLED" }, { status: 503 });

  let sender: string;
  let userId: number | null = null;
  if (WATERX_LOCAL_SIGN && localSigner()) {
    sender = localSigner()!.toSuiAddress();
  } else {
    userId = await readEntryIdFromRequest(req);
    if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
    const denied = await denyUnlessAppApproved(userId);
    if (denied) return denied;
    const rl = await rateLimitAsync({ key: `predict:claim:${userId}`, limit: 60, windowSec: 3600 });
    if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } });
    const user = await userById(userId);
    if (!user?.sui_address) return NextResponse.json({ error: "user not found" }, { status: 404 });
    sender = user.sui_address;
  }

  const accountId = userId != null ? await getStoredAccount(userId) : null;
  if (!accountId) return NextResponse.json({ error: "no account" }, { status: 409 });

  let b: { positionIds?: string[] };
  try { b = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const positionIds = (b.positionIds ?? []).map(String).filter(Boolean);
  if (!positionIds.length) return NextResponse.json({ error: "positionIds required" }, { status: 400 });

  try {
    const tx = await buildClaimTx(accountId, positionIds);
    const result = await settle(tx, sender);
    return NextResponse.json({ ...result, claimed: positionIds.length });
  } catch (err) {
    const msg = (err as Error).message ?? "failed";
    console.warn(`[predict/claim] failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
