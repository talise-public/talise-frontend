import { NextResponse } from "next/server";
import { userById } from "@/lib/db";
import { getChequeForClaim, countryAllowlist, microsToUsd } from "@/lib/cheques";
import { fetchAndOpenNote } from "@/lib/cheque-note";

export const runtime = "nodejs";

/**
 * GET /api/cheques/:id/preview?s=<secret>
 *
 * Unauthenticated read for rendering the cheque before claiming. The secret is
 * checked constant-time; a mismatch returns 404 (NOT 403) so cheque ids can't
 * be enumerated. Never returns the amount/sender without the right secret.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const secret = new URL(req.url).searchParams.get("s") ?? "";
  const cq = await getChequeForClaim(id, secret);
  if (!cq) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // These three reads are independent — the creator lookup, the country
  // allowlist, and the Walrus note fetch. Run them concurrently.
  const [creator, allowedCountries, note] = await Promise.all([
    userById(cq.creatorUserId),
    countryAllowlist(id),
    // Private note: the link holds the secret, so the holder can decrypt the
    // sender's message (fetched from Walrus). Best-effort, null if absent/unreadable.
    fetchAndOpenNote(secret, cq.noteBlobId),
  ]);
  const creatorDisplay =
    creator?.talise_username
      ? `${creator.talise_username}@talise.sui`
      : creator?.business_name ?? creator?.name ?? "A Talise user";

  const now = Date.now();
  const expired = cq.expiresAt < now;

  return NextResponse.json({
    id: cq.id,
    amountUsd: microsToUsd(cq.amountMicros),
    status: expired && cq.status === "funded" ? "expired" : cq.status,
    payeeLabel: cq.payeeLabel,
    memo: cq.memo,
    signatureName: cq.signatureName,
    note,
    creatorDisplay,
    allowedCountries, // [] = any country; non-empty = IP must geolocate into it
    requireCaptcha: true,
    expiresAt: cq.expiresAt,
    claimable: cq.status === "funded" && !expired,
  });
}
