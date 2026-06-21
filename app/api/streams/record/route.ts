import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { requireAppAttestStructural } from "@/lib/app-attest";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import {
  createStreamRecord,
  newStreamId,
  streamOnchainEnabled,
  parseCreatedStreamObjectId,
} from "@/lib/streams";

export const runtime = "nodejs";

/**
 * POST /api/streams/record
 *
 * Called by iOS after the funding tx (from /api/streams/create-prepare) has
 * confirmed. Inserts the `streams` row in state `active` so the scheduler
 * picks it up.
 *
 *   • ESCROW path (STREAM_PACKAGE_ID unset): the funding tx is a plain USDsui
 *     send into the escrow address — there's no on-chain Stream object, so we
 *     mint a server-side `str_…` id and trust the client-forwarded funding
 *     digest + plan (which the server itself produced in create-prepare and
 *     the limits ledger already reserved).
 *   • ON-CHAIN path (streamOnchainEnabled): the funding tx was a SPONSORED
 *     `stream::create<USDSUI>` that shared a real Stream<USDSUI> object. We
 *     parse the created object id from the confirmed funding digest (via the
 *     gRPC tx read) and store THAT as the stream's id — the cron then releases
 *     tranches against the real on-chain object. If the object can't be parsed
 *     (tx not yet indexed / failed), we reject so we never persist a synthetic
 *     id for an on-chain stream.
 *
 * Body: `{ fundingDigest, recipientAddress, recipientHandle?, totalMicros,
 *          trancheMicros, numTranches, startMs, intervalMs }`.
 */

const ADDRESS_RE = /^0x[a-f0-9]{1,64}$/i;
const UINT_RE = /^\d+$/;

export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const attest = requireAppAttestStructural(req);
  if (attest) return attest;

  const rl = await rateLimitAsync({
    key: `streams-record:user:${userId}`,
    limit: 20,
    windowSec: 3600,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }

  // Streaming is on-chain only now (escrow rail retired) — gate on the same
  // condition as create-prepare so funding + record agree. Requiring the escrow
  // key here would 503 every on-chain stream right after a successful funding.
  if (!streamOnchainEnabled()) {
    return NextResponse.json(
      { error: "Streaming payments aren't available.", code: "STREAM_ONCHAIN_REQUIRED" },
      { status: 503 }
    );
  }

  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: {
    fundingDigest?: string;
    recipientAddress?: string;
    recipientHandle?: string | null;
    totalMicros?: string;
    trancheMicros?: string;
    numTranches?: number | string;
    startMs?: number | string;
    intervalMs?: number | string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const fundingDigest = (body.fundingDigest ?? "").trim();
  if (!fundingDigest) {
    return NextResponse.json({ error: "fundingDigest required" }, { status: 400 });
  }
  const recipientAddress = (body.recipientAddress ?? "").trim().toLowerCase();
  if (!ADDRESS_RE.test(recipientAddress)) {
    return NextResponse.json({ error: "invalid recipientAddress" }, { status: 400 });
  }

  const totalMicrosStr = String(body.totalMicros ?? "");
  const trancheMicrosStr = String(body.trancheMicros ?? "");
  if (!UINT_RE.test(totalMicrosStr) || !UINT_RE.test(trancheMicrosStr)) {
    return NextResponse.json(
      { error: "totalMicros and trancheMicros must be u64 decimal strings" },
      { status: 400 }
    );
  }
  const totalMicros = BigInt(totalMicrosStr);
  const trancheMicros = BigInt(trancheMicrosStr);

  const numTranches = Math.floor(Number(body.numTranches));
  const startMs = Math.floor(Number(body.startMs));
  const intervalMs = Math.floor(Number(body.intervalMs));
  if (
    !Number.isInteger(numTranches) || numTranches <= 0 ||
    !Number.isInteger(startMs) || startMs <= 0 ||
    !Number.isInteger(intervalMs) || intervalMs <= 0
  ) {
    return NextResponse.json({ error: "invalid schedule" }, { status: 400 });
  }
  if (totalMicros <= 0n || trancheMicros <= 0n) {
    return NextResponse.json({ error: "invalid amounts" }, { status: 400 });
  }

  // On-chain: the stream id IS the created Stream<USDSUI> object id, parsed
  // from the confirmed funding tx. Escrow: a synthetic server-side id.
  let id: string;
  if (streamOnchainEnabled()) {
    const objectId = await parseCreatedStreamObjectId(fundingDigest);
    if (!objectId) {
      console.warn(
        `[streams/record] on-chain create object not found for digest=${fundingDigest} user=${userId}`
      );
      return NextResponse.json(
        {
          error:
            "Couldn't confirm the on-chain stream yet. Wait a moment and retry.",
          code: "STREAM_OBJECT_UNCONFIRMED",
        },
        { status: 409 }
      );
    }
    id = objectId;
  } else {
    id = newStreamId();
  }

  try {
    await createStreamRecord({
      id,
      senderUserId: userId,
      senderAddress: user.sui_address,
      recipientAddress,
      recipientHandle: (body.recipientHandle ?? null) || null,
      totalMicros,
      trancheMicros,
      numTranches,
      startMs,
      intervalMs,
      fundingDigest,
    });
  } catch (err) {
    console.warn(`[streams/record] insert failed user=${userId}: ${(err as Error).message}`);
    return NextResponse.json({ error: "couldn't record stream" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id, state: "active" });
}
