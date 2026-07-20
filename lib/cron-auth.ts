import { NextResponse } from "next/server";

/**
 * Cron authentication, FAIL CLOSED.
 *
 * Vercel injects `Authorization: Bearer $CRON_SECRET` on scheduled invocations.
 * The previous inline pattern (`if (secret) { check }`) failed OPEN: if
 * CRON_SECRET were ever unset, the money-adjacent cron loops (stream release,
 * yield rebalance, shield indexer) would run for ANY caller. This helper rejects
 * when the secret is missing OR the header doesn't match, so an ops mistake
 * can't expose a cron endpoint.
 *
 * Returns a Response to short-circuit with, or null when the caller is
 * authorized.
 */
export function requireCron(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: "cron not configured (CRON_SECRET unset)" },
      { status: 503 }
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
