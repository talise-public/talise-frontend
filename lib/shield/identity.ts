import "server-only";

import { db, userById } from "@/lib/db";
import { ensureShieldSchema } from "@/lib/shield/db";

/**
 * Shield-identity REGISTRY, the lookup rail for hidden-amount shielded
 * transfers (Workstream C).
 *
 * A shielded TRANSFER spends one of the sender's notes and mints a new note
 * OWNED BY THE RECIPIENT (encrypted to the recipient's enc key, public_amount=0
 * so nothing about the amount or the recipient lands on-chain). To do that the
 * sender needs the recipient's shield SPENDING pubkey + enc pubkey, but those
 * never touch the chain. This registry is the off-chain directory: each user
 * publishes their pubkeys once (keyed to their stable Talise account id), and a
 * sender resolves a recipient by their public sui_address.
 *
 *   pubkey     , Poseidon1(spendingKey) as a u256 DECIMAL string.
 *   encPubkeyHex, 0x04-prefixed uncompressed P-256 point (0x04 + 128 hex).
 *
 * PILOT TRUST NOTE: pubkeys are operator-readable (consistent with the
 * operator-trusted pilot posture). They are PUBLIC keys, disclosing them does
 * not weaken the shielding; the spending SECRET stays on-device / in escrow.
 */

/**
 * Publish (or update) the caller's shield identity. The sui_address is resolved
 * SERVER-SIDE from the account row, never trust a body-supplied address, so a
 * caller can only ever claim an identity for their own on-chain address.
 */
export async function publishShieldIdentity(
  userId: string,
  pubkey: string,
  encPubkeyHex: string
): Promise<void> {
  await ensureShieldSchema();

  const user = await userById(Number(userId));
  if (!user) throw new Error("no such user");
  const suiAddress = user.sui_address;

  const now = Date.now();
  // UPSERT by user_id: re-publishing (e.g. after a master rotation) refreshes
  // the keys and the resolved address while preserving created_at.
  await db().execute({
    sql: `INSERT INTO shield_identity (user_id, sui_address, pubkey, enc_pubkey, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (user_id) DO UPDATE SET
            sui_address = EXCLUDED.sui_address,
            pubkey      = EXCLUDED.pubkey,
            enc_pubkey  = EXCLUDED.enc_pubkey,
            updated_at  = EXCLUDED.updated_at`,
    args: [String(userId), suiAddress, pubkey, encPubkeyHex, now, now],
  });
}

/**
 * Resolve a recipient's shield identity by their public sui_address. Returns
 * null when the recipient has never published one (the sender then can't mint a
 * note for them and must fall back to a public/unshielded path).
 */
export async function shieldIdentityFor(
  suiAddress: string
): Promise<{ pubkey: string; encPubkeyHex: string } | null> {
  await ensureShieldSchema();
  const r = await db().execute({
    sql: `SELECT pubkey, enc_pubkey FROM shield_identity WHERE sui_address = ? LIMIT 1`,
    args: [suiAddress],
  });
  const row = r.rows[0] as { pubkey?: string; enc_pubkey?: string } | undefined;
  if (!row?.pubkey || !row?.enc_pubkey) return null;
  return { pubkey: row.pubkey, encPubkeyHex: row.enc_pubkey };
}
