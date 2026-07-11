import { NextResponse } from "next/server";
import { getDisplayRates } from "@/lib/display-fx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/fx — USD-base FX rates for the currencies Talise displays.
 *
 * Powered by open.er-api.com (free, no key), cached 1h server-side. The actual
 * fetch + cache live in `lib/display-fx.ts` so the AI agent converts local
 * amounts with the EXACT SAME rate this endpoint shows the app.
 *
 * Response: { base: "USD", asOf: <iso>, rates: { USD: 1, NGN: …, … } }
 */
export async function GET() {
  return NextResponse.json(await getDisplayRates());
}
