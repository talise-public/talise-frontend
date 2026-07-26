import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import { requireAppAttestStructural } from "@/lib/app-attest";
import { LOG, creditRoundupSave } from "@/lib/rewards/roundup";

export const runtime = "nodejs";

/**
 * POST /api/send/save-confirm
 *
 * Body: `{ digest, saveProof }` → `{ status, savedUsd, reason? }`.
 *
 * Re-reads a Spend + Save send off chain and credits the savings tally if it
 * verifies. Called by the client ONLY when `/api/zk/sponsor-execute` came back
 * with `save.status === "pending"`, i.e. the send landed but the read path was
 * lagging behind the broadcast and we refused to credit on a guess.
 *
 * ── This is not a queue and not a cron ──────────────────────────────────
 *
 * There is no server-side state here: no row, no schedule, no drain, nothing
 * to reconcile. The only durable artifacts are the transaction itself (on
 * chain) and the HMAC proof (held by the client). This endpoint does exactly
 * what sponsor-execute already did in-line — read the digest, verify it, credit
 * once — and it exists so that a fullnode indexing lag of a few seconds doesn't
 * permanently lose a save the user genuinely made. If the client never calls
 * it, nothing is credited and nothing is owed: honest, just under-reported.
 *
 * ── Why it is safe to expose ─────────────────────────────────────────────
 *
 * Every guard lives in `creditRoundupSave`, not here:
 *   • the proof is HMAC-signed by the server, so the amount and the digest
 *     cannot be authored or altered client-side;
 *   • the proof's `userId` must match the caller's session;
 *   • the proof's digest must equal the digest presented;
 *   • the credit is bounded by what the chain shows reaching NAVI;
 *   • a UNIQUE `claim_key` means the tally moves at most once per send, so
 *     hammering this route is pointless.
 *
 * The worst a caller can do is spend our RPC budget re-reading their own
 * transaction, which the rate limit below bounds.
 */
export async function POST(req: Request) {
  const attestBlock = requireAppAttestStructural(req);
  if (attestBlock) return attestBlock;

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const [denied, rl, user] = await Promise.all([
    denyUnlessAppApproved(userId),
    // Sends are capped at 30/hr on both rails and each produces at most one
    // save, so 60/hr is ample headroom for retries without being a free
    // chain-read faucet.
    rateLimitAsync({
      key: `save-confirm:user:${userId}`,
      limit: 60,
      windowSec: 3600,
    }),
    userById(userId),
  ]);
  if (denied) return denied;
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: { digest?: string; saveProof?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const digest = (body.digest ?? "").trim();
  const saveProof = (body.saveProof ?? "").trim();
  if (!digest || !saveProof) {
    return NextResponse.json(
      { error: "digest and saveProof are both required" },
      { status: 400 }
    );
  }

  try {
    const outcome = await creditRoundupSave({
      userId,
      senderAddress: user.sui_address,
      digest,
      proofToken: saveProof,
      // One extra look beyond sponsor-execute's three. By the time a client
      // gets here the transaction is seconds old, so it should read cleanly.
      verifyRetries: 2,
    });
    return NextResponse.json({
      status: outcome.status,
      savedUsd: outcome.status === "saved" ? outcome.savedUsd : 0,
      ...(outcome.status === "saved" ? {} : { reason: outcome.reason }),
    });
  } catch (err) {
    const msg = (err as Error).message ?? "confirm failed";
    console.warn(`${LOG} save-confirm threw user=${userId} ${digest}: ${msg}`);
    // Never a hard failure: the send already landed. The tally simply stays
    // where it is, which is the honest outcome for a save we cannot prove.
    return NextResponse.json({ status: "pending", savedUsd: 0, reason: msg });
  }
}
