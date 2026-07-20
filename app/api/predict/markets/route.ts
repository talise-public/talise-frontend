import { NextResponse } from "next/server";
import { WATERX_ENABLED } from "@/lib/waterx";
import { listPredictionMarkets } from "@/lib/waterx-predict";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/predict/markets, live WaterX prediction markets (read-only). */
export async function GET() {
  if (!WATERX_ENABLED) {
    return NextResponse.json({ error: "Prediction isn't enabled.", code: "PERPS_DISABLED" }, { status: 503 });
  }
  try {
    const markets = await listPredictionMarkets();
    return NextResponse.json(
      { venue: "WaterX", network: "mainnet", settlement: "USDsui", markets },
      { headers: { "Cache-Control": "public, max-age=5, stale-while-revalidate=20" } },
    );
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message ?? "read failed" }, { status: 502 });
  }
}
