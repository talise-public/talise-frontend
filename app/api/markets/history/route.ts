import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { WATERX_ENABLED, getTrades, addTrade, type TradeLogEntry } from "@/lib/waterx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/markets/history, the user's recorded perp trade history. */
export async function GET(req: Request) {
  if (!WATERX_ENABLED) return NextResponse.json({ trades: [] });
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ trades: [] });
  return NextResponse.json({ trades: await getTrades(userId) });
}

/** POST /api/markets/history, record a completed trade (client posts after signing). */
export async function POST(req: Request) {
  if (!WATERX_ENABLED) return NextResponse.json({ ok: false }, { status: 503 });
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ ok: false }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  let b: Partial<TradeLogEntry>;
  try { b = await req.json(); } catch { return NextResponse.json({ ok: false }, { status: 400 }); }
  const type = b.type;
  if (type !== "open" && type !== "close" && type !== "deposit" && type !== "withdraw") {
    return NextResponse.json({ ok: false, error: "bad type" }, { status: 400 });
  }
  await addTrade(userId, {
    ts: Date.now(),
    type,
    ticker: b.ticker ? String(b.ticker) : undefined,
    side: b.side === "short" ? "short" : b.side === "long" ? "long" : undefined,
    sizeTokens: typeof b.sizeTokens === "number" ? b.sizeTokens : undefined,
    priceUsd: typeof b.priceUsd === "number" ? b.priceUsd : undefined,
    collateralUsd: typeof b.collateralUsd === "number" ? b.collateralUsd : undefined,
    pnlUsd: typeof b.pnlUsd === "number" ? b.pnlUsd : undefined,
    feeUsd: typeof b.feeUsd === "number" ? b.feeUsd : undefined,
    digest: b.digest ? String(b.digest) : undefined,
  });
  return NextResponse.json({ ok: true });
}
