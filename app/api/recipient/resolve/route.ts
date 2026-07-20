import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { resolveRecipient } from "@/lib/suins";
import { userBySuiAddress } from "@/lib/db";
import { getPrimaryBankAccount, last4 } from "@/lib/bank-accounts";
import { resolveLinqBank } from "@/lib/linq-banks";
import { shieldIdentityFor } from "@/lib/shield/identity";

export const runtime = "nodejs";

/**
 * Masked view of a resolved recipient's PRIMARY payout bank. Powers the Send
 * flow's "pay to their bank" option. Only ever exposes the bank name + last
 * 4 digits, NEVER the full account number. `null` when the recipient can't
 * be mapped to a Talise user or has no primary bank on file.
 */
type RecipientBank = {
  hasPrimary: boolean;
  bankName: string | null;
  last4: string | null;
} | null;

/**
 * Resolve a recipient's primary payout bank from the address SuiNS gave us.
 * Returns null on any miss (not a Talise user / no primary / lookup hiccup)
 *, this is an additive, best-effort field and must never fail resolution.
 */
async function recipientBankFor(address: string): Promise<RecipientBank> {
  try {
    const user = await userBySuiAddress(address);
    if (!user) return null;
    const bank = await getPrimaryBankAccount(user.id);
    if (!bank) return null;
    const bankName = resolveLinqBank(bank.bank_code)?.name ?? bank.bank_code;
    return { hasPrimary: true, bankName, last4: last4(bank.account_number) };
  } catch (e) {
    console.warn("[recipient/resolve] bank lookup failed:", (e as Error).message);
    return null;
  }
}

/**
 * The recipient's shield identity (Poseidon spend pubkey + P-256 enc pubkey),
 * used by the sender to mint a hidden-amount shielded note OWNED BY THE
 * RECIPIENT. `null` when the recipient hasn't published a shield identity or
 * the lookup hiccups, additive + best-effort, must never fail resolution.
 */
type RecipientShieldIdentity = {
  pubkey: string;
  encPubkeyHex: string;
} | null;

/**
 * Resolve a recipient's published shield identity from the address SuiNS gave
 * us. Returns null on any miss, additive, best-effort, never throws.
 */
async function shieldIdentityForAddress(
  address: string
): Promise<RecipientShieldIdentity> {
  try {
    const id = await shieldIdentityFor(address);
    if (!id) return null;
    return { pubkey: id.pubkey, encPubkeyHex: id.encPubkeyHex };
  } catch (e) {
    console.warn(
      "[recipient/resolve] shield identity lookup failed:",
      (e as Error).message
    );
    return null;
  }
}

/**
 * GET /api/recipient/resolve?q=<input>
 *
 * Returns { address, displayName, recipientBank, shieldIdentity } on a match.
 * `recipientBank` is the recipient's masked PRIMARY payout bank (bankName +
 * last4 only) or null. `shieldIdentity` is the recipient's shield spend/enc
 * pubkeys (for hidden-amount shielded transfers) or null. Returns 404 when
 * input is well formed but unknown, and 400 when it's malformed. Authenticated
 * only, we don't want to leak the handle table to crawlers.
 */
export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId)
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) {
    return NextResponse.json({ error: "empty query" }, { status: 400 });
  }

  try {
    const resolved = await resolveRecipient(q);
    if (!resolved) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const recipientBank = await recipientBankFor(resolved.address);
    const shieldIdentity = await shieldIdentityForAddress(resolved.address);
    return NextResponse.json({ ...resolved, recipientBank, shieldIdentity });
  } catch (err) {
    // Resolution touches SuiNS RPC + DB; either can transiently flake.
    // 502 instead of 500 so callers can distinguish "I couldn't reach
    // the lookup service" from a code bug.
    console.warn(
      `[recipient/resolve] q=${q.slice(0, 32)} failed: ${(err as Error).message}`
    );
    return NextResponse.json(
      { error: "lookup failed" },
      { status: 502 }
    );
  }
}
