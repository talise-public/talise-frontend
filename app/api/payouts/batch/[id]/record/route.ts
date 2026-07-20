import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { db, userById } from "@/lib/db";
import { recordSend } from "@/lib/send-limits";

export const runtime = "nodejs";

/**
 * POST /api/payouts/batch/[id]/record
 *
 * Called by the web app after the sponsored batch PTB (from
 * /api/payouts/batch/prepare) has been signed + executed and a digest is in
 * hand. Marks the batch `status='broadcast'` with the confirmed digest.
 * Mirrors /api/streams/record: auth, owner check, idempotent state advance.
 *
 * Body: `{ digest }`.
 */

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const batchId = (id ?? "").trim();
  if (!batchId) {
    return NextResponse.json({ error: "missing batch id" }, { status: 400 });
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // Private-beta guardrail: account must be on the app allowlist.
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;

  const rl = await rateLimitAsync({
    key: `payouts-batch-record:user:${userId}`,
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

  let body: { digest?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const digest = (body.digest ?? "").trim();
  if (!digest) {
    return NextResponse.json({ error: "digest required" }, { status: 400 });
  }

  const c = db();
  const found = await c.execute({
    sql: "SELECT id, user_id, total_usd, status, digest FROM payout_batches WHERE id = ? LIMIT 1",
    args: [batchId],
  });
  const row = found.rows[0] as
    | {
        id: string;
        user_id: string | null;
        total_usd: number | null;
        status: string | null;
        digest: string | null;
      }
    | undefined;
  if (!row) {
    return NextResponse.json({ error: "batch not found" }, { status: 404 });
  }

  // Owner check, the batch must belong to the caller. user_id is stored as a
  // string at prepare time; compare stringified.
  if (String(row.user_id) !== String(userId)) {
    return NextResponse.json({ error: "not your batch" }, { status: 403 });
  }

  // Idempotent: a re-post with the same digest is a no-op success.
  if (row.status === "broadcast" && row.digest === digest) {
    return NextResponse.json({ ok: true, batchId, status: "broadcast", digest });
  }

  try {
    await c.execute({
      sql: "UPDATE payout_batches SET status = 'broadcast', digest = ? WHERE id = ?",
      args: [digest, batchId],
    });
  } catch (err) {
    console.warn(
      `[payouts/batch/record] update failed user=${userId} batch=${batchId}: ${(err as Error).message}`
    );
    return NextResponse.json({ error: "couldn't record batch" }, { status: 500 });
  }

  // Best-effort: reserve the batch total against the rolling send-limit
  // window now that it has actually broadcast. Only record on a fresh
  // broadcast (status wasn't already 'broadcast') so a retry can't
  // double-count. recordSend never throws.
  if (row.status !== "broadcast" && typeof row.total_usd === "number" && row.total_usd > 0) {
    void recordSend({
      userId,
      amountUsd: row.total_usd,
      asset: "USDsui",
      digest,
    });
  }

  return NextResponse.json({ ok: true, batchId, status: "broadcast", digest });
}
