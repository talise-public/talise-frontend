import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { WATERX_ENABLED, WATERX_LOCAL_SIGN, localSigner, getStoredAccount } from "@/lib/waterx";
import { listPredictionPositions } from "@/lib/waterx-predict";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/predict/positions, the caller's prediction positions (+ claimable). */
export async function GET(req: Request) {
  if (!WATERX_ENABLED) return NextResponse.json({ error: "disabled", code: "PERPS_DISABLED" }, { status: 503 });

  let accountId: string | null = null;
  if (WATERX_LOCAL_SIGN && localSigner()) {
    accountId = new URL(req.url).searchParams.get("accountId");
  } else {
    const userId = await readEntryIdFromRequest(req);
    if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
    const denied = await denyUnlessAppApproved(userId);
    if (denied) return denied;
    accountId = await getStoredAccount(userId);
  }
  if (!accountId) return NextResponse.json({ positions: [] });

  try {
    const positions = await listPredictionPositions(accountId);
    return NextResponse.json({ positions });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message ?? "read failed" }, { status: 502 });
  }
}
