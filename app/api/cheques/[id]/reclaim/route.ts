import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import { requireAppAttestStructural } from "@/lib/app-attest";
import {
  getCheque,
  chequeOnchainEnabled,
  reclaimChequeBuilder,
  recordReclaim,
  voidCheque,
  microsToUsd,
} from "@/lib/cheques";

export const runtime = "nodejs";

/**
 * POST /api/cheques/:id/reclaim
 *
 * CREATOR-only. Pulls an UNCLAIMED (funded) cheque back to its creator. The
 * creator can reclaim any time the cheque is unclaimed, no expiry wait, and
 * the on-chain `cheque::reclaim` asserts `!claimed`, so a claim and a reclaim
 * can never both succeed.
 *
 * TWO rails (picked by `CHEQUE_PACKAGE_ID`):
 *
 *   • ON-CHAIN, a TWO-STEP sponsored flow mirroring create:
 *       1. POST with NO `digest` → returns the Onara-SPONSORED
 *          `cheque::reclaim` PTB bytes. The CREATOR signs them (the contract
 *          asserts `ctx.sender() == cheque.creator`) and POSTs to
 *          /api/zk/sponsor-execute; the contract returns the Coin<T> to the
 *          creator.
 *       2. POST WITH `{ digest }` (the reclaim tx) → verifies CREATOR
 *          ownership and atomically flips funded→reclaimed (records
 *          `reclaim_digest`).
 *
 *   • ESCROW (fallback), performs the escrow→creator transfer immediately
 *     (the existing `voidCheque`) and flips funded→voided.
 *
 * Body: {} (build) | { digest } (confirm), on-chain only.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const attestBlock = requireAppAttestStructural(req);
  if (attestBlock) return attestBlock;

  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  // Money-moving route, per-user global rate limit (anti-abuse), same shape
  // as /api/cheques/create.
  const rl = await rateLimitAsync({
    key: `cheques-reclaim:user:${userId}`,
    limit: 30,
    windowSec: 3600,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }

  const { id } = await params;
  let body: { digest?: string } = {};
  try {
    body = (await req.json()) as { digest?: string };
  } catch {
    // An empty/absent body is valid (the on-chain BUILD step sends nothing).
    body = {};
  }

  const cq = await getCheque(id);
  if (!cq) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // CREATOR-only: verify the authenticated user IS the creator.
  if (cq.creatorUserId !== userId) {
    return NextResponse.json({ error: "not_owner" }, { status: 403 });
  }

  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  // Reclaim only applies to an unclaimed, funded cheque.
  if (cq.status !== "funded") {
    return NextResponse.json(
      { error: "not_reclaimable", status: cq.status },
      { status: 409 }
    );
  }

  // ── On-chain rail ──
  if (chequeOnchainEnabled()) {
    if (!cq.chequeObjectId) {
      return NextResponse.json(
        { error: "missing_cheque_object", code: "MISSING_CHEQUE_OBJECT" },
        { status: 409 }
      );
    }

    // Step 2: confirm, a reclaim digest was provided. Record it CREATOR-only.
    if (body.digest) {
      const r = await recordReclaim({
        chequeId: id,
        creatorUserId: userId,
        digest: body.digest,
      });
      if (!r.ok) {
        return NextResponse.json({ error: r.reason ?? "reclaim_failed" }, { status: 409 });
      }
      return NextResponse.json({ ok: true, status: "reclaimed", digest: body.digest });
    }

    // Step 1: build, return the sponsored `cheque::reclaim` PTB for the
    // creator to sign.
    try {
      const { bytes: reclaimBytes, sponsor } = await reclaimChequeBuilder({
        chequeObjectId: cq.chequeObjectId,
        creatorAddress: user.sui_address,
      });
      return NextResponse.json({
        chequeId: id,
        mode: "onchain",
        reclaimBytes, // sponsor-ready; creator signs → /api/zk/sponsor-execute
        sponsor,
        amountUsd: microsToUsd(cq.amountMicros),
      });
    } catch (e) {
      console.error(`[cheques/reclaim] build failed cheque=${id}: ${(e as Error).message}`);
      return NextResponse.json(
        { error: "Couldn't prepare the reclaim. Please try again.", code: "ONCHAIN_BUILD_FAILED" },
        { status: 500 }
      );
    }
  }

  // ── Escrow rail (fallback): escrow→creator transfer, funded→voided ──
  const r = await voidCheque({
    chequeId: id,
    creatorUserId: userId,
    creatorAddress: user.sui_address,
  });
  if (!r.ok) return NextResponse.json({ error: r.reason ?? "reclaim_failed" }, { status: 409 });
  return NextResponse.json({ ok: true, status: "voided", digest: r.digest });
}
