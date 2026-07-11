import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { refreshBridgeKyc } from "@/lib/onramp/bridge";
import { getOnrampKyc, upsertOnrampKyc } from "@/lib/onramp/kyc-store";
import { bridgeConfigured } from "@/lib/bridge/client";
import { ensureSchema } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/kyc/bridge/status
 *
 * Poll Bridge for the live KYC/TOS status of the signed-in user and backfill
 * the persisted `onramp_kyc` record. Used by the client after starting hosted
 * KYC to know when verification has cleared.
 *
 * 503 when Bridge isn't configured. If the user hasn't started KYC (no link or
 * customer id on file) returns `{ started:false, status:"unverified" }`. On a
 * Bridge fetch error we return the last-known status with `stale:true` rather
 * than 500. Does NOT move money or touch any balance/limit path.
 */
export async function GET(req: Request) {
  if (!bridgeConfigured()) {
    return NextResponse.json({ error: "bridge_disabled" }, { status: 503 });
  }
  await ensureSchema(); // apply onramp_kyc.kyc_link_id before reading it
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const rec = await getOnrampKyc(userId);
  if (!rec || (!rec.kycLinkId && !rec.providerCustomerId)) {
    return NextResponse.json({ started: false, status: "unverified" });
  }

  try {
    const r = await refreshBridgeKyc({
      kycLinkId: rec.kycLinkId,
      providerCustomerId: rec.providerCustomerId,
    });
    // Backfill: passing undefined leaves the stored id untouched (store COALESCE),
    // passing the real id overwrites any placeholder.
    await upsertOnrampKyc(userId, {
      status: r.status,
      providerCustomerId: r.customerId ?? undefined,
    });
    return NextResponse.json({
      started: true,
      status: r.status,
      kycStatus: r.kycStatus,
      tosStatus: r.tosStatus,
      customerId: r.customerId,
    });
  } catch (e) {
    console.error(`[kyc/bridge/status] refresh failed user=${userId}: ${(e as Error).message}`);
    return NextResponse.json({ started: true, status: rec.status, stale: true });
  }
}
