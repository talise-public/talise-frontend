import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import { createRequest, listRequestsFor, normalizeCurrency } from "@/lib/requests";

export const runtime = "nodejs";

/**
 * POST /api/requests, create a payment request ("I need $X from you").
 *   Body: { amountUsd, currency?, requesterNote?, note?, ttlMs? }
 *   Any signed-in (app-approved) user can issue one. Returns
 *   `{ ok, request, payUrl }` where payUrl is the public /req/<id> link.
 *
 * GET /api/requests, list the caller's requests, newest first.
 *
 * Auth + app-access + rate-limit mirror /api/invoices.
 */

const ABS_BASE = (process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/+$/, "");

/** Build the public request URL for a slug from the request origin. */
function reqUrlFor(req: Request, id: string): string {
  let origin = ABS_BASE;
  if (!origin) {
    try {
      origin = new URL(req.url).origin;
    } catch {
      origin = "https://www.talise.io";
    }
  }
  return `${origin}/req/${id}`;
}

export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // Private-beta guardrail: account must be on the app allowlist.
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;

  const rl = await rateLimitAsync({
    key: `requests-create:user:${userId}`,
    limit: 60,
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

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const amountUsd = Number(body.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return NextResponse.json(
      { error: "The requested amount must be greater than zero." },
      { status: 400 }
    );
  }
  if (amountUsd > 1_000_000) {
    return NextResponse.json(
      { error: "The requested amount exceeds the maximum." },
      { status: 400 }
    );
  }

  const ttlMs =
    body.ttlMs != null && Number.isFinite(Number(body.ttlMs))
      ? Number(body.ttlMs)
      : null;

  const request = await createRequest({
    userId,
    amountUsd,
    currency: normalizeCurrency(body.currency),
    requesterNote:
      typeof body.requesterNote === "string" ? body.requesterNote : null,
    note: typeof body.note === "string" ? body.note : null,
    ttlMs,
  });

  return NextResponse.json({
    ok: true,
    request,
    payUrl: reqUrlFor(req, request.id),
  });
}

export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const requests = await listRequestsFor(userId);
  return NextResponse.json({ requests });
}
