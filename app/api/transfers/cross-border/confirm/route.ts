import { NextResponse } from "next/server";

import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { requireAppAttestStructural } from "@/lib/app-attest";
import { rateLimitAsync, getClientIp } from "@/lib/rate-limit";
import { confirmCrossBorder } from "@/lib/cross-border";

export const runtime = "nodejs";

/**
 * POST /api/transfers/cross-border/confirm
 *
 * Same auth gate as /api/send/sponsor-prepare (session/bearer +
 * structural App Attest for mobile). Drives the transfers state machine
 * for a previously-quoted cross-border transfer:
 *
 *   quoted → debited → onchain_settling   (then per-corridor fiat-out)
 *
 * For the LIVE NG corridor the fiat-out is the Linq off-ramp path (the
 * actual payout fires from the on-chain-confirm hook AFTER finality, per
 * the commit-point semantics). Partner corridors advance to
 * `fiat_out_pending` as a documented stub.
 *
 * Body: { transferId }
 * 200:  { state, transferId }
 * 4xx:  { error, code }
 */

export async function POST(req: Request) {
  const attestBlock = requireAppAttestStructural(req);
  if (attestBlock) return attestBlock;

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated", code: "BAD_INPUT" }, { status: 401 });
  }
  // Private-beta guardrail: signed-in is not enough, the account must be on
  // the app allowlist before it can originate any value-moving call.
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found", code: "BAD_INPUT" }, { status: 404 });
  }

  const rl = await rateLimitAsync({
    key: `xborder-confirm:user:${userId}:${getClientIp(req)}`,
    limit: 20,
    windowSec: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", code: "BAD_INPUT" },
      { status: 429, headers: rl.retryAfterSec ? { "Retry-After": String(rl.retryAfterSec) } : undefined }
    );
  }

  let body: { transferId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad json", code: "BAD_INPUT" }, { status: 400 });
  }

  const transferId = typeof body.transferId === "string" ? body.transferId.trim() : "";
  if (!transferId) {
    return NextResponse.json({ error: "transferId is required", code: "BAD_INPUT" }, { status: 400 });
  }

  const res = await confirmCrossBorder(userId, transferId);
  if (!res.ok) {
    const status =
      res.code === "NOT_FOUND"
        ? 404
        : res.code === "FORBIDDEN"
          ? 403
          : res.code === "CONFLICT"
            ? 409
            : res.code === "INTERNAL"
              ? 500
              : 400;
    return NextResponse.json({ error: res.message, code: res.code }, { status });
  }

  return NextResponse.json({ state: res.state, transferId: res.transferId });
}
