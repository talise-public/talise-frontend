import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { onrampStatus } from "@/lib/onramp/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/onramp/config
 *
 * THE one place every client asks "is fiat funding open?". Web (`/app/ramps`),
 * iOS (`RampFlagsStore`) and Android (`OnrampApi.config`) all read this, so the
 * flag flips for all three by changing `ONRAMP_ENABLED` in the environment,
 * with NO app release and NO redeploy (the value is read per request, it is
 * deliberately NOT a build-inlined `NEXT_PUBLIC_*`).
 *
 * Read-only: no money moves, no DB write, nothing user-specific is returned.
 * Auth is required only so we don't publish our provider posture to the world.
 *
 * Response:
 *   {
 *     enabled: boolean,               // the only field to branch the flow on
 *     provider: "bridge" | "transak",
 *     configured: boolean,            // provider credentials present
 *     closedReason: "switch_off" | "provider_unconfigured" | null,
 *     funding: "bank" | "widget",     // which UI to render when enabled
 *     deliverAsset: "USDC" | "USDSUI",
 *     requiresSwapToUsdsui: boolean
 *   }
 */
export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  // Never cached: the whole point is that flipping the env var takes effect on
  // the next request.
  return NextResponse.json(onrampStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
