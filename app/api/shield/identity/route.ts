import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { publishShieldIdentity, shieldIdentityFor } from "@/lib/shield/identity";
import { userById } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Shield-identity REGISTRY endpoint, the lookup rail for hidden-amount
 * shielded transfers (Workstream C).
 *
 * POST { pubkey, encPubkeyHex } → publish the caller's own shield identity.
 * GET                          → read back the caller's own identity.
 *
 * The on-chain address is resolved server-side from the authed account, so a
 * caller can only ever publish an identity for their own sui_address.
 */

// u256 decimal string: 1–78 digits (2^256-1 is 78 digits), no leading-zero
// ambiguity beyond a bare "0".
function isU256Decimal(s: string): boolean {
  if (!/^[0-9]{1,78}$/.test(s)) return false;
  if (s.length > 1 && s[0] === "0") return false;
  return true;
}

/** GET → the caller's own identity: `{ identity: { pubkey, encPubkeyHex } | null }`. */
export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;

  const user = await userById(Number(userId));
  if (!user) return NextResponse.json({ identity: null });

  const identity = await shieldIdentityFor(user.sui_address);
  return NextResponse.json({ identity });
}

/** POST { pubkey, encPubkeyHex } → publish. */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;

  let body: { pubkey?: string; encPubkeyHex?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const pubkey = String(body.pubkey ?? "").trim();
  const encPubkeyHex = String(body.encPubkeyHex ?? "").trim();

  // pubkey = Poseidon1(spendingKey) as a u256 decimal string.
  if (!isU256Decimal(pubkey)) {
    return NextResponse.json({ error: "pubkey must be a u256 decimal string" }, { status: 400 });
  }
  // encPubkeyHex = 0x04 + 128 hex chars (uncompressed P-256 point).
  if (!/^0x04[0-9a-fA-F]{128}$/.test(encPubkeyHex)) {
    return NextResponse.json(
      { error: "encPubkeyHex must be 0x04 + 128 hex chars" },
      { status: 400 }
    );
  }

  await publishShieldIdentity(String(userId), pubkey, encPubkeyHex);
  return NextResponse.json({ ok: true });
}
