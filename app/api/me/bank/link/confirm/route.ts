import { NextResponse } from "next/server";

import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import { resolveLinqBank } from "@/lib/linq-banks";
import {
  countBankAccounts,
  markBankAccountPrimary,
  maskBankAccount,
  upsertBankAccount,
} from "@/lib/bank-accounts";

export const runtime = "nodejs";

/**
 * POST /api/me/bank/link/confirm
 *
 * Step 2 of linking an NGN bank account. The client has signed the
 * `attestMessage` from /prepare (a zkLogin personal-message signature)
 * and POSTs it back as `digest`. We UPSERT the account into
 * `user_bank_accounts` with `attestation_digest = digest`.
 *
 * `digest` is treated opaquely: it's the user's personal-message
 * signature in the chosen (personal-message) attestation approach, but
 * the column would equally hold an executed-attestation tx digest if a
 * future on-chain approach is wired, confirm doesn't care which.
 *
 * Body:
 *   {
 *     bankCode: string,
 *     accountNumber: string,   // the full 10-digit number from /prepare
 *     accountName: string,     // the resolved name from /prepare
 *     digest: string           // the attestation (signature or tx digest)
 *   }
 *
 * Response: 200
 *   { account: { id, bankCode, bankName, accountName, last4, attested } }
 *
 * Errors:
 *   400  bad json / missing or malformed fields
 *   401  not authenticated
 *   404  user not found
 *   429  rate limited
 *   500  persist failed
 */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const rl = await rateLimitAsync({
    key: `me-bank-link-confirm:user:${userId}`,
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

  let body: {
    bankCode?: string;
    accountNumber?: string;
    accountName?: string;
    digest?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const bankCode = String(body.bankCode ?? "").trim();
  const accountNumber = String(body.accountNumber ?? "").trim();
  const accountName = String(body.accountName ?? "").trim();
  const digest = String(body.digest ?? "").trim();
  const bank = resolveLinqBank(bankCode);

  if (!bank) {
    return NextResponse.json({ error: "Unknown bankCode." }, { status: 400 });
  }
  if (!/^\d{10}$/.test(accountNumber)) {
    return NextResponse.json(
      { error: "accountNumber must be 10 digits." },
      { status: 400 }
    );
  }
  if (!accountName) {
    return NextResponse.json(
      { error: "accountName is required." },
      { status: 400 }
    );
  }
  if (!digest) {
    return NextResponse.json(
      { error: "digest (the signed attestation) is required." },
      { status: 400 }
    );
  }

  try {
    // First account a user links becomes their PRIMARY payout target
    // automatically. Count BEFORE the (idempotent) upsert so re-linking an
    // existing account never silently flips the primary.
    const hadNone = (await countBankAccounts(userId)) === 0;
    const row = await upsertBankAccount({
      userId,
      bankCode,
      accountNumber,
      accountName,
      attestationDigest: digest,
    });
    if (hadNone) {
      await markBankAccountPrimary(userId, row.id);
      row.is_primary = true;
    }
    return NextResponse.json({ account: maskBankAccount(row) });
  } catch (e) {
    console.warn("[me/bank/link/confirm] upsert failed:", (e as Error).message);
    return NextResponse.json(
      { error: "Could not save the linked account." },
      { status: 500 }
    );
  }
}
