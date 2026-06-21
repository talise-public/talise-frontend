import { NextResponse } from "next/server";

import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import { verifyBank, linqConfigured } from "@/lib/linq";
import { resolveLinqBank } from "@/lib/linq-banks";
import { bankLinkAttestMessage, last4 } from "@/lib/bank-accounts";

export const runtime = "nodejs";

/**
 * POST /api/me/bank/link/prepare
 *
 * Step 1 of linking an NGN bank account to the caller's Talise @handle.
 *
 *   1. Verify the account via Linq (`verifyBank`) to resolve the holder
 *      name. A verification failure → 422 (the account couldn't be
 *      resolved; nothing is persisted).
 *   2. Build the ATTESTATION the user signs to consent to the link.
 *
 * ── ATTESTATION APPROACH: zkLogin personal-message signature ──────────
 *
 * We return a deterministic `attestMessage`:
 *
 *     talise/v1|bank-link|<bankCode>|<last4>
 *
 * which the client signs as a personal message with the SAME zkLogin
 * identity that owns the user's Talise @handle. The resulting signature
 * is the on-chain-identity attestation of consent, stored by /confirm as
 * `attestation_digest`.
 *
 * Why personal-message and NOT a sponsored Payment Kit tx:
 *   The existing sponsored-memo machinery (appendPaymentKitReceipt) carries
 *   its memo in a Payment Kit `nonce` that is HARD-CAPPED at 36 bytes and
 *   uses a FIXED-WIDTH binary-packed format (see lib/intents/wrap-payment-kit.ts):
 *   `t1<kind><ts8><rand4><sender6><receiver6>`. It has no slot for a
 *   free-form `talise/v1|bank-link|<bankCode>|<last4>` string, and bolting a
 *   new "bank-link" kind onto that shared parser would be invasive and
 *   would still not carry the bank code / last4 verbatim. A personal-message
 *   signature carries the EXACT consent string, costs no gas, needs no
 *   sponsor/coin sourcing, and is the documented fallback for exactly this
 *   case. /confirm accepts the signature (or any executed-attestation digest)
 *   as `digest`.
 *
 * Response: 200
 *   {
 *     attestMessage: string,   // the deterministic string the user signs
 *     accountName: string,     // resolved holder name (from Linq)
 *     bankName: string,
 *     bankCode: string,
 *     accountNumber: string,   // echoed back so /confirm gets the full number
 *     last4: string
 *   }
 *
 * Errors:
 *   400  bad json / missing or malformed bankCode|accountNumber
 *   401  not authenticated
 *   404  user not found
 *   422  Linq could not verify the account (name unresolved)
 *   429  rate limited
 *   503  off-ramp (Linq) not configured
 */
export async function POST(req: Request) {
  if (!linqConfigured()) {
    return NextResponse.json(
      { error: "off-ramp not configured" },
      { status: 503 }
    );
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const rl = await rateLimitAsync({
    key: `me-bank-link-prepare:user:${userId}`,
    limit: 10,
    windowSec: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } }
    );
  }

  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: { bankCode?: string; accountNumber?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const bankCode = String(body.bankCode ?? "").trim();
  const accountNumber = String(body.accountNumber ?? "").trim();
  const bank = resolveLinqBank(bankCode);

  if (!bank) {
    return NextResponse.json(
      { error: "Unknown bankCode." },
      { status: 400 }
    );
  }
  if (!/^\d{10}$/.test(accountNumber)) {
    return NextResponse.json(
      { error: "accountNumber must be 10 digits." },
      { status: 400 }
    );
  }

  // Resolve the account holder name via Linq. A failure here means the
  // account couldn't be verified — 422, persist nothing.
  let accountName: string;
  try {
    const verified = await verifyBank({ bankCode, accountNumber });
    accountName = String(verified.accountName ?? "").trim();
    if (!accountName) throw new Error("empty accountName");
  } catch (e) {
    console.warn("[me/bank/link/prepare] verifyBank failed:", (e as Error).message);
    return NextResponse.json(
      { error: "Could not verify that bank account. Check the details and try again." },
      { status: 422 }
    );
  }

  const attestMessage = bankLinkAttestMessage({ bankCode, accountNumber });

  return NextResponse.json({
    attestMessage,
    accountName,
    bankName: bank.name,
    bankCode,
    accountNumber,
    last4: last4(accountNumber),
  });
}
