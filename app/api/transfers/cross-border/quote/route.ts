import { NextResponse } from "next/server";

import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { requireAppAttestStructural } from "@/lib/app-attest";
import { rateLimitAsync, getClientIp } from "@/lib/rate-limit";
import { quoteCrossBorder } from "@/lib/cross-border";
import { getCorridor, type CountryCode } from "@/lib/corridors";

export const runtime = "nodejs";

/**
 * POST /api/transfers/cross-border/quote
 *
 * Same auth gate as /api/send/sponsor-prepare (session/bearer +
 * structural App Attest for mobile). Prices a cross-border send in the
 * corridor's SOURCE currency, gates KYC tier + caps, and persists a
 * `transfers` row in `quoted`.
 *
 * Body: { fromCountry, toCountry, amount }   // amount in source currency
 * 200:  { transferId, corridor, quote, amountUsd, tier, recipientGets }
 * 4xx:  { error, code }  code ∈ UNKNOWN_CORRIDOR | NOT_BOOKABLE | OVER_CAP
 *                              | TIER_BLOCKED | LIMIT_EXCEEDED | FX | BAD_INPUT
 */

// Country codes the corridor registry knows about. We validate the request
// against the LIVE registry rather than a hardcoded list so a new corridor
// country becomes accepted the moment it's added to corridors.ts.
function isCountryCode(x: unknown): x is CountryCode {
  return typeof x === "string" && /^[A-Z]{2}$/.test(x);
}

export async function POST(req: Request) {
  // App Attest (structural) — mirrors the offramp gate. No-op for web
  // cookie sessions; enforced for mobile bearer traffic.
  const attestBlock = requireAppAttestStructural(req);
  if (attestBlock) return attestBlock;

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated", code: "BAD_INPUT" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found", code: "BAD_INPUT" }, { status: 404 });
  }

  // Per-user rate limit (quoting hits the live FX feed + a DB write).
  const rl = await rateLimitAsync({
    key: `xborder-quote:user:${userId}:${getClientIp(req)}`,
    limit: 30,
    windowSec: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", code: "BAD_INPUT" },
      { status: 429, headers: rl.retryAfterSec ? { "Retry-After": String(rl.retryAfterSec) } : undefined }
    );
  }

  let body: { fromCountry?: unknown; toCountry?: unknown; amount?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad json", code: "BAD_INPUT" }, { status: 400 });
  }

  const fromCountry = typeof body.fromCountry === "string" ? body.fromCountry.trim().toUpperCase() : "";
  const toCountry = typeof body.toCountry === "string" ? body.toCountry.trim().toUpperCase() : "";
  if (!isCountryCode(fromCountry) || !isCountryCode(toCountry)) {
    return NextResponse.json(
      { error: "fromCountry and toCountry must be ISO-3166 alpha-2 codes", code: "BAD_INPUT" },
      { status: 400 }
    );
  }
  // Cheap registry pre-check so an obviously-unknown route returns the
  // contract code without a DB/FX round-trip. quoteCrossBorder re-validates.
  if (!getCorridor(fromCountry, toCountry)) {
    return NextResponse.json(
      { error: "No corridor for that route.", code: "UNKNOWN_CORRIDOR" },
      { status: 400 }
    );
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { error: "amount must be a positive number", code: "BAD_INPUT" },
      { status: 400 }
    );
  }

  const res = await quoteCrossBorder(userId, fromCountry, toCountry, amount);
  if (!res.ok) {
    // TIER_BLOCKED / LIMIT_EXCEEDED are authorization failures (403);
    // everything else is a 400 bad-request / unpriceable-request.
    const status = res.code === "TIER_BLOCKED" || res.code === "LIMIT_EXCEEDED" ? 403 : 400;
    return NextResponse.json({ error: res.message, code: res.code }, { status });
  }

  return NextResponse.json(res.result);
}
