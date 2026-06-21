import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { db, ensureSchema } from "@/lib/db";
import { setUserTier, getUserTier, normalizeTier, isKycTier } from "@/lib/kyc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * eKYC provider approval webhook (cross-border master plan §7).
 *
 * THIS CLOSES THE VERIFICATION LOOP. The POST /api/kyc route records an
 * upgrade INTENT and kicks off the (mock today, Sumsub/Persona later)
 * eKYC check, which resolves asynchronously and almost always lands in
 * `pending`. Nothing promoted `users.kyc_tier` until now — this endpoint
 * is the only path that does, and only on a provider-signed `approved`
 * verdict tied to a real intent row.
 *
 * Body (provider-agnostic, normalized at the adapter boundary):
 *   { ref: string, status: "approved" | "rejected" | "pending" }
 *   `ref` is the opaque provider reference we persisted on the intent.
 *
 * Auth: HMAC-SHA256 over the raw body, hex, in `x-ekyc-signature`, keyed
 * by EKYC_WEBHOOK_SECRET (constant-time compare — same pattern as
 * /api/onramp/webhook). When the secret is unset we FAIL CLOSED in
 * production (a tier promotion is a privilege escalation — never accept
 * it unsigned in prod) but allow in dev with a loud warning so the loop
 * is testable locally.
 *
 * Idempotent: re-delivery of the same verdict is a no-op 200. A promotion
 * only ever raises the tier (never lowers it) and only when the resolved
 * verdict matches the intent's requested tier.
 */

function verifySignature(rawBody: string, sigHeader: string | null): "ok" | "missing-secret-dev" | "bad" {
  const secret = process.env.EKYC_WEBHOOK_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") return "bad";
    console.warn(
      "[kyc/webhook] EKYC_WEBHOOK_SECRET unset — accepting UNSIGNED webhook in dev only. Set it before production; tier promotion must be signed."
    );
    return "missing-secret-dev";
  }
  if (!sigHeader) return "bad";
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sigHeader, "utf8");
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  return valid ? "ok" : "bad";
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const verdict = verifySignature(rawBody, req.headers.get("x-ekyc-signature"));
  if (verdict === "bad") {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let body: { ref?: unknown; status?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const ref = typeof body.ref === "string" ? body.ref.trim() : "";
  const status = body.status;
  if (!ref) {
    return NextResponse.json({ error: "missing ref" }, { status: 400 });
  }
  if (status !== "approved" && status !== "rejected" && status !== "pending") {
    return NextResponse.json({ error: "bad status" }, { status: 400 });
  }

  await ensureSchema();

  // Resolve the intent this verdict belongs to. The ref is unique per
  // submission, so this identifies the user + the tier they were trying
  // to reach without trusting any user id from the (external) webhook body.
  const intentRes = await db().execute({
    sql: `SELECT id, user_id, requested_tier, ekyc_status
            FROM kyc_upgrade_intents WHERE ekyc_ref = ? LIMIT 1`,
    args: [ref],
  });
  const intent = intentRes.rows[0];
  if (!intent) {
    // Unknown ref — don't leak whether it ever existed; 404 so the
    // provider stops retrying against a bad reference.
    return NextResponse.json({ error: "unknown ref" }, { status: 404 });
  }

  const userId = Number(intent.user_id);
  const requestedTier = normalizeTier(intent.requested_tier);
  const priorStatus = String(intent.ekyc_status ?? "");

  // Idempotency: if this verdict was already recorded, no-op.
  if (priorStatus === status) {
    return NextResponse.json({ ok: true, idempotent: true, status });
  }

  // Record the resolved verdict on the intent regardless of outcome.
  await db().execute({
    sql: `UPDATE kyc_upgrade_intents SET ekyc_status = ? WHERE id = ?`,
    args: [status, intent.id],
  });

  // Promotion happens ONLY on approval and ONLY as a RAISE. Guard against
  // a stale/out-of-order approval for a lower tier demoting a user who has
  // since cleared a higher one (setUserTier itself is an unconditional
  // write, reserved for admin use — the raise-only policy lives here).
  if (status === "approved" && isKycTier(requestedTier) && requestedTier > 0) {
    const current = await getUserTier(userId);
    if (requestedTier > current) {
      await setUserTier(userId, requestedTier);
      console.log(
        `[kyc/webhook] promoted user=${userId} ${current} -> tier ${requestedTier} (ref=${ref}${verdict === "missing-secret-dev" ? ", UNSIGNED-dev" : ""})`
      );
      return NextResponse.json({ ok: true, promoted: true, tier: requestedTier });
    }
    return NextResponse.json({ ok: true, promoted: false, reason: "not_a_raise", tier: current });
  }

  return NextResponse.json({ ok: true, promoted: false, status });
}
