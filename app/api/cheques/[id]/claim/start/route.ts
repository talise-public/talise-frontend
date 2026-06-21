import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { getChequeForClaim, countryAllowlist, microsToUsd } from "@/lib/cheques";

export const runtime = "nodejs";

/**
 * POST /api/cheques/:id/claim/start  { secret }
 *
 * Authed claimer entry point. Validates the secret + cheque state and tells the
 * client which checks the claim will run (captcha always; an IP-country gate if
 * the cheque has an allowlist). The checks themselves run server-side at
 * /claim/release — this is just so the UI can present the captcha.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { id } = await params;
  let body: { secret?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const cq = await getChequeForClaim(id, body.secret ?? "");
  if (!cq) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const expired = cq.expiresAt < Date.now();
  if (cq.status !== "funded" || expired) {
    return NextResponse.json({
      claimable: false,
      status: expired && cq.status === "funded" ? "expired" : cq.status,
    });
  }

  return NextResponse.json({
    claimable: true,
    amountUsd: microsToUsd(cq.amountMicros),
    requireCaptcha: true,
    allowedCountries: await countryAllowlist(id),
  });
}
