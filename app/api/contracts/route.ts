import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import { streamById } from "@/lib/streams";
import {
  createWorkContract,
  workContractsFor,
  projectContract,
  isCadence,
} from "@/lib/work-contracts";

export const runtime = "nodejs";

/**
 * Work contracts API.
 *
 * The MONEY moves through the EXISTING stream endpoints, the client funds the
 * stream first (POST /api/streams/create-prepare → sign → POST
 * /api/streams/record) and then calls THIS route to persist the contract
 * metadata that wraps the resulting stream id. This route never moves money;
 * it links a confirmed stream to the human-facing arrangement (role, rate,
 * cadence) so the Work UI can render it.
 *
 * POST /api/contracts
 *   { payeeAddress, payeeHandle?, title, rateUsd, cadence, periods, streamId,
 *     fundingDigest? } → { ok, contract }
 *   The streamId MUST belong to a stream the caller is the SENDER of (verified
 *   against the streams row), you can't attach a contract to someone else's
 *   stream.
 *
 * GET /api/contracts → { contracts: ProjectedContract[] }
 *   The caller's contracts, each merged with its live stream progress
 *   (paidUsd / remainingUsd / periodsPaid / nextPayAt / streamState).
 */

export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const rl = await rateLimitAsync({
    key: `contracts-create:user:${userId}`,
    limit: 30,
    windowSec: 3600,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }

  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: {
    payeeAddress?: string;
    payeeHandle?: string | null;
    title?: string;
    rateUsd?: number | string;
    cadence?: string;
    periods?: number | string;
    streamId?: string;
    fundingDigest?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const streamId = (body.streamId ?? "").trim();
  if (!streamId) {
    return NextResponse.json({ error: "streamId required" }, { status: 400 });
  }

  // The contract may only wrap a stream the caller actually owns (is sender of).
  // This is the authority check, without it a user could attach a contract to
  // any stream id and pollute another user's contract list / progress view.
  const stream = await streamById(streamId);
  if (!stream) {
    return NextResponse.json(
      { error: "stream not found, fund the contract first", code: "STREAM_NOT_FOUND" },
      { status: 404 }
    );
  }
  if (stream.sender_user_id !== userId) {
    return NextResponse.json(
      { error: "you can only attach a contract to your own stream" },
      { status: 403 }
    );
  }

  const title = (body.title ?? "").trim();
  if (!title) {
    return NextResponse.json({ error: "A role / title is required." }, { status: 400 });
  }

  const cadence = body.cadence;
  if (!isCadence(cadence)) {
    return NextResponse.json(
      { error: "cadence must be one of hourly, daily, weekly, monthly" },
      { status: 400 }
    );
  }

  const rateUsd = Number(body.rateUsd);
  if (!Number.isFinite(rateUsd) || rateUsd <= 0) {
    return NextResponse.json(
      { error: "rateUsd must be a positive number" },
      { status: 400 }
    );
  }

  const periods = Math.floor(Number(body.periods));
  if (!Number.isInteger(periods) || periods <= 0) {
    return NextResponse.json(
      { error: "periods must be a positive integer" },
      { status: 400 }
    );
  }

  // Prefer the canonical pay coordinates from the stream row (server-truth)
  // over the client-supplied payeeAddress.
  const payeeAddress = stream.recipient_address;

  const row = await createWorkContract({
    userId,
    payeeAddress,
    payeeHandle:
      (typeof body.payeeHandle === "string" ? body.payeeHandle : null) ||
      stream.recipient_handle ||
      null,
    title,
    rateUsd,
    cadence,
    periods,
    streamId,
    fundingDigest:
      (typeof body.fundingDigest === "string" ? body.fundingDigest : null) ||
      stream.funding_digest ||
      null,
  });

  const contract = await projectContract(row);
  return NextResponse.json({ ok: true, contract });
}

export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const rows = await workContractsFor(userId);
  const contracts = await Promise.all(rows.map((r) => projectContract(r)));
  return NextResponse.json({ contracts });
}
