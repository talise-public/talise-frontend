import { NextResponse } from "next/server";
import { getSuiUsdcPrice, getMarginPoolInfo } from "@/lib/deepbook";
import { network } from "@/lib/sui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/deepbook
 *
 * Read-only price + pool snapshot. Gated to development to avoid exposing
 * internal pool state as a publicly-cacheable surface in production.
 */
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const [suiUsdc, usdc, sui] = await Promise.all([
    getSuiUsdcPrice(),
    getMarginPoolInfo("USDC"),
    getMarginPoolInfo("SUI"),
  ]);
  return NextResponse.json({
    network: network(),
    sui_usdc_price: suiUsdc,
    margin: { usdc, sui },
    ts: new Date().toISOString(),
  });
}
