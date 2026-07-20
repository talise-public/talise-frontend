import "server-only";

import { coinWithBalance, type Transaction, type TransactionObjectArgument } from "@mysten/sui/transactions";
import { sui } from "@/lib/sui";
import { USDSUI_TYPE } from "@/lib/usdsui";
import { gql } from "@/lib/sui-graphql";

/**
 * Source a `Coin<USDSUI>` of exactly `micros` for a PTB, from WHEREVER the user's
 * USDsui actually lives:
 *   • owned `Coin<USDSUI>` objects  → `coinWithBalance({useGasCoin:false})` auto
 *     merges/splits them.
 *   • the Address-Balance accumulator (the gasless-send rail) → `tx.balance(...)`
 *     gives a `Balance`, wrapped to a `Coin` via `0x2::coin::from_balance`.
 *
 * Why this exists: `coinWithBalance` ONLY sees owned coin objects. Most Talise
 * users' USDsui sits in the accumulator (gasless `send_funds` credits it there,
 * not as coins), so a coins-only builder reverts on execution, which silently
 * broke goal deposits + earn supply + spend-and-save. This mirrors the fix
 * already in lib/streams.ts `buildStreamCreateSponsored`, generalized.
 */
export async function sourceUsdsuiCoin(
  tx: Transaction,
  sender: string,
  micros: bigint
): Promise<TransactionObjectArgument> {
  if (micros <= 0n) throw new Error("amount too small");

  let coinTotal = 0n;
  try {
    const res = await (sui() as unknown as {
      listCoins: (a: { owner: string; coinType: string }) => Promise<{ objects?: Array<{ balance?: string }> }>;
    }).listCoins({ owner: sender, coinType: USDSUI_TYPE });
    for (const o of res.objects ?? []) coinTotal += BigInt(o.balance ?? "0");
  } catch {
    // listCoins read failed, fall through to the accumulator path.
  }

  if (coinTotal >= micros) {
    return tx.add(coinWithBalance({ type: USDSUI_TYPE, balance: micros, useGasCoin: false }));
  }
  // Accumulator → Balance → Coin.
  return tx.moveCall({
    target: "0x2::coin::from_balance",
    typeArguments: [USDSUI_TYPE],
    arguments: [tx.balance({ type: USDSUI_TYPE, balance: micros })],
  }) as unknown as TransactionObjectArgument;
}

const GOAL_VAULT_PRINCIPAL_QUERY = /* GraphQL */ `
  query GoalVaultPrincipal($id: SuiAddress!) {
    object(address: $id) {
      asMoveObject { contents { json } }
    }
  }
`;

/**
 * Read a GoalVault's idle `principal` balance (in USDsui micro-units), best-effort.
 * Returns null when the object can't be read or the field can't be parsed, the
 * caller should then fall back rather than trust a stale number.
 *
 * The on-chain `withdraw` asserts `principal >= amount`; the DB "tracking"
 * figure can drift ABOVE the real principal (e.g. legacy DB-tracked deposits, or
 * deposits that reverted), so callers clamp the requested amount to this value to
 * avoid the EInsufficientBalance (301) abort.
 */
export async function readGoalVaultPrincipalMicros(vaultId: string): Promise<bigint | null> {
  try {
    const data = await gql<{ object?: { asMoveObject?: { contents?: { json?: Record<string, unknown> } } } }>(
      GOAL_VAULT_PRINCIPAL_QUERY,
      { id: vaultId },
      { noCache: true } // live principal, must not serve a stale cached value
    );
    const json = data?.object?.asMoveObject?.contents?.json;
    if (!json) return null;
    const p = (json as Record<string, unknown>).principal;
    // Balance<T> may serialize as a bare number/string, or as { value }.
    const raw =
      typeof p === "string" || typeof p === "number"
        ? p
        : (p && typeof p === "object" && "value" in p ? (p as { value: unknown }).value : null);
    if (raw == null) return null;
    return BigInt(String(raw));
  } catch {
    return null;
  }
}
