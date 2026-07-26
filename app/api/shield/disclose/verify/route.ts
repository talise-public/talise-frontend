import { NextResponse } from "next/server";
import { getClientIp, rateLimitAsync } from "@/lib/rate-limit";
import { SHIELD_RPC, shieldMaintenance } from "@/lib/shield/onchain";
import {
  DEFAULT_FULLNODE_URL,
  verifyDisclosureReceipt,
} from "@/lib/shield/disclosure/verify";

export const runtime = "nodejs";

/** Hard cap on the request body. A receipt is small; 512 KB is generous. */
const MAX_BODY_BYTES = 512 * 1024;
const MAX_OPENINGS = 100;

/**
 * Fullnodes this route is willing to consult. An arbitrary caller-supplied URL
 * would make this an SSRF pivot into our network, so the URL is allowlisted by
 * HOST. A verifier who wants to use their own node should not be asking us at
 * all — they should run `scripts/verify-shield-disclosure.mjs` (or import
 * `lib/shield/disclosure/verify`) locally, which is the trust-minimising path
 * and takes any node they like. This route is a convenience, nothing more.
 */
const ALLOWED_FULLNODE_HOSTS = new Set(
  [
    "fullnode.mainnet.sui.io",
    "sui-mainnet.public.blastapi.io",
    "sui-rpc.publicnode.com",
    "sui-mainnet-endpoint.blockvision.org",
    hostOf(SHIELD_RPC),
  ].filter((h): h is string => !!h)
);

function hostOf(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}

/**
 * POST /api/shield/disclose/verify   { receipt, fullnodeUrl? }
 *
 * Verifies a disclosure receipt: the Poseidon opening of every note, plus the
 * on-chain anchor for each commitment. Returns the full per-note verdict along
 * with an explicit list of what the receipt does NOT prove.
 *
 * ── This route is a CONVENIENCE, not the trust root ────────────────────────
 * A receipt is designed to be verified WITHOUT Talise. Asking us to verify one
 * means trusting us about the answer, which defeats the point. The response
 * therefore always carries `trustNote` telling the caller how to check it
 * themselves, and the same code path they would run locally is the code path
 * used here (`lib/shield/disclosure/verify`, no server-only imports).
 *
 * ── Privacy ───────────────────────────────────────────────────────────────
 * The request body contains opened notes, i.e. blinding factors. This route
 * NEVER logs the body, never logs a commitment or an amount, and NEVER persists
 * anything. It is a pure function of its input plus a public fullnode read.
 *
 * Unauthenticated on purpose: a counterparty or auditor holding a receipt is
 * not a Talise user. Rate-limited per IP instead. Gated by
 * `shieldMaintenance()` like the rest of the feature, so it ships dark.
 */
export async function POST(req: Request) {
  if (shieldMaintenance()) {
    return NextResponse.json(
      { error: "Private sends are currently in maintenance.", code: "SHIELD_MAINTENANCE" },
      { status: 503 }
    );
  }

  const ip = getClientIp(req);
  const rl = await rateLimitAsync({
    key: `shield-disclose-verify:ip:${ip}`,
    limit: 60,
    windowSec: 3600,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }

  // Read as text first so an oversized body is rejected before JSON parsing.
  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ error: "unreadable body" }, { status: 400 });
  }
  if (text.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "receipt too large" }, { status: 413 });
  }

  let body: {
    receipt?: unknown;
    fullnodeUrl?: unknown;
    offlineOnly?: unknown;
    expectedOwnerPubkey?: unknown;
  };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  // Accept either { receipt: {...} } or a bare receipt document.
  const receipt =
    body && typeof body === "object" && "receipt" in body && body.receipt
      ? body.receipt
      : body;

  let fullnodeUrl = DEFAULT_FULLNODE_URL;
  if (typeof body.fullnodeUrl === "string" && body.fullnodeUrl.trim()) {
    const candidate = body.fullnodeUrl.trim();
    let host: string | null = null;
    try {
      const u = new URL(candidate);
      if (u.protocol !== "https:") throw new Error("not https");
      host = u.host;
    } catch {
      return NextResponse.json({ error: "fullnodeUrl must be an https URL" }, { status: 400 });
    }
    if (!ALLOWED_FULLNODE_HOSTS.has(host)) {
      return NextResponse.json(
        {
          error: "fullnodeUrl host is not allowlisted here",
          hint:
            "Run the verifier yourself to point at any node: " +
            "node --loader ./scripts/shield-node-loader.mjs scripts/verify-shield-disclosure.mjs <receipt.json> --fullnode <url>",
          allowed: [...ALLOWED_FULLNODE_HOSTS],
        },
        { status: 400 }
      );
    }
    fullnodeUrl = candidate;
  }

  // Optional: the owner pubkey every note must be addressed to. Supplying it is
  // what turns "a note of X exists" into "a note of X was paid to this key" —
  // without it, the payer (who also knows the blinding) could open a note they
  // created for themselves.
  let expectedOwnerPubkey: string | undefined;
  if (typeof body.expectedOwnerPubkey === "string" && body.expectedOwnerPubkey.trim()) {
    const p = body.expectedOwnerPubkey.trim();
    if (!/^(0|[1-9][0-9]{0,77})$/.test(p)) {
      return NextResponse.json(
        { error: "expectedOwnerPubkey must be a u256 decimal string" },
        { status: 400 }
      );
    }
    expectedOwnerPubkey = p;
  }

  try {
    const result = await verifyDisclosureReceipt(receipt, {
      fullnodeUrl,
      offlineOnly: body.offlineOnly === true,
      maxOpenings: MAX_OPENINGS,
      expectedOwnerPubkey,
    });
    return NextResponse.json({
      ...result,
      trustNote:
        "This verdict came from Talise's server. A disclosure receipt is designed " +
        "to be checked WITHOUT trusting Talise: run lib/shield/disclosure/verify " +
        "(or scripts/verify-shield-disclosure.mjs) against any Sui fullnode you " +
        "choose and compare. The receipt digest identifies the exact bytes checked.",
    });
  } catch (err) {
    // Deliberately does not echo the message back with the body attached, and
    // logs no receipt content — an error string could carry an amount.
    console.warn("[shield/disclose/verify] verification threw");
    return NextResponse.json(
      { error: "verification failed", detail: (err as Error).message },
      { status: 500 }
    );
  }
}
