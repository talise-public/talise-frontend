import { NextResponse } from "next/server";
import { getCurrentEpoch } from "@/lib/sui-epoch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Returns the current Sui epoch. Used client-side to choose a sane maxEpoch
 * when generating the ephemeral key pair, without bundling the Sui SDK on
 * the public landing.
 *
 * Backed by the shared `getCurrentEpoch()` helper (gRPC `LedgerService`).
 * The legacy JSON-RPC `getLatestSuiSystemState` call was retired in sub-plan
 * 1.1; the response shape (`{ epoch: "<string>" }`) is preserved so iOS
 * clients keep parsing it the same way.
 */
export async function GET() {
  try {
    const epoch = await getCurrentEpoch();
    // The epoch is GLOBAL and flips only ~every 24h, and the only consumer
    // (`maxEpoch = epoch + 2`) tolerates a ~2-epoch window — so this is safe
    // to serve from Vercel's CDN. Edge-caching it keeps sign-in fast: a cold
    // serverless instance otherwise pays an ~850ms gRPC read here BEFORE the
    // Google screen opens.
    return NextResponse.json(
      { epoch: String(epoch) },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
        },
      }
    );
  } catch (err) {
    console.warn(`[api/sui/epoch] RPC failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: "could not read current Sui epoch" },
      { status: 502 }
    );
  }
}
