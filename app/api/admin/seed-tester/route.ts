import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-auth";
import { userByHandle } from "@/lib/db";
import { suiscanTxUrl } from "@/lib/sui";
import {
  treasurySendUsdsui,
  offrampRefundEnabled,
} from "@/lib/offramp-refund";

export const runtime = "nodejs";

/**
 * POST /api/admin/seed-tester — ADMIN-ONLY closed-alpha money-in.
 *
 * Credits an invited tester a small USDsui balance to transact with, sent from
 * the off-ramp treasury (`OFFRAMP_TREASURY_SK`). This is the fast "treasury
 * seed" path to fund the alpha without a live card on-ramp — the real Bridge/
 * Transak on-ramp slots in later. Capped + admin-gated.
 *
 * Body: { handle?: "@alice" | "alice", address?: "0x…", amountUsd: number }.
 * Resolve order: explicit `address` wins; else `handle` → the user's Sui address.
 *
 * Usage (with an admin session cookie or the x-admin-token header):
 *   curl -X POST $ORIGIN/api/admin/seed-tester \
 *     -H 'x-admin-token: $ADMIN_TOKEN' -H 'content-type: application/json' \
 *     -d '{"handle":"alice","amountUsd":25}'
 */

const ADDR_RE = /^0x[a-fA-F0-9]{64}$/;
const MAX_SEED_USD = 100; // alpha seeding is small by design

export async function POST(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;

  if (!offrampRefundEnabled()) {
    return NextResponse.json(
      { error: "treasury not configured (OFFRAMP_TREASURY_SK missing)" },
      { status: 503 }
    );
  }

  let body: { handle?: unknown; address?: unknown; amountUsd?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const amountUsd = Number(body.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return NextResponse.json({ error: "amountUsd must be greater than zero" }, { status: 400 });
  }
  if (amountUsd > MAX_SEED_USD) {
    return NextResponse.json(
      { error: `amountUsd exceeds the ${MAX_SEED_USD} cap` },
      { status: 400 }
    );
  }

  // Resolve the destination address: explicit address wins, else a @handle.
  let address: string | null = null;
  if (typeof body.address === "string" && ADDR_RE.test(body.address.trim())) {
    address = body.address.trim();
  } else if (typeof body.handle === "string" && body.handle.trim()) {
    const handle = body.handle.trim().replace(/^@/, "").toLowerCase();
    const u = await userByHandle(handle);
    if (!u) {
      return NextResponse.json({ error: `no user with handle @${handle}` }, { status: 404 });
    }
    if (!u.sui_address || !ADDR_RE.test(u.sui_address)) {
      return NextResponse.json({ error: "that user has no Sui address yet" }, { status: 409 });
    }
    address = u.sui_address;
  }
  if (!address) {
    return NextResponse.json(
      { error: "provide a valid `address` (0x…) or `handle`" },
      { status: 400 }
    );
  }

  let digest: string;
  try {
    digest = await treasurySendUsdsui(address, amountUsd);
  } catch (e) {
    console.error(`[admin/seed-tester] send failed to ${address}: ${(e as Error).message}`);
    return NextResponse.json(
      { error: `seed failed: ${(e as Error).message}` },
      { status: 502 }
    );
  }

  console.log(`[admin/seed-tester] sent ${amountUsd} USDsui to ${address} digest=${digest}`);
  return NextResponse.json({
    ok: true,
    address,
    amountUsd,
    digest,
    explorerUrl: suiscanTxUrl(digest),
  });
}
