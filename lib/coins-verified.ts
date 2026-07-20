import "server-only";

import { USDSUI_TYPE } from "@/lib/usdsui";
import { cetusUniverse } from "@/lib/cetus-tokens";

/**
 * COIN VERIFICATION, the single gate for which coins Talise shows + offers to
 * convert. ALWAYS IGNORE NON-VERIFIED coins: spam/airdrop tokens (e.g. random
 * "LMAGMA_COIN") must never appear in balances, never be offered for a
 * "Convert all to USDsui" swap (they have no Cetus liquidity → the aggregator
 * aborts with "insufficient liquidity"), and never leak a raw error into
 * activity. A coin is shown/convertible ONLY if it is verified.
 *
 * Source = Cetus's verified-token registry, fetched + cached, with a hardcoded
 * ALLOWLIST FLOOR as the always-trusted fallback so the home screen can never
 * break if the Cetus fetch is slow/unreachable. (Per the chosen design.)
 */

/** A coin must have at least this much on-chain liquidity to be convertible -
 *  below it the Cetus aggregator aborts with "insufficient liquidity" (exactly
 *  what spam coins like LMAGMA_COIN do). Such coins are ignored entirely. */
const MIN_LIQUIDITY_USD = 100;

/** Canonicalize a Sui coin type: lowercase + zero-pad the address to 64 hex so
 *  short ("0x2::sui::SUI") and long forms compare equal. */
function norm(t: string): string {
  const parts = t.split("::");
  if (parts.length !== 3) return t.toLowerCase();
  const addr = parts[0].toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return `0x${addr}::${parts[1]}::${parts[2]}`;
}

/**
 * Always-verified floor, coins we KNOW are Cetus-verified with deep liquidity,
 * i.e. the ones a convert-to-USDsui swap actually succeeds on. This is both the
 * trusted core AND the fallback when the Cetus registry can't be fetched.
 */
const VERIFIED_FLOOR = new Set(
  [
    USDSUI_TYPE,
    "0x2::sui::SUI",
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
    "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
    "0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS",
  ].map(norm)
);

/**
 * The full verified set: the hardcoded floor PLUS every coin that has a liquid
 * Cetus pool (fetched live from Cetus `stats_pools`, cached 1h). This is what
 * lets real holdings like WAL, DEEP, BUCK, etc. show in the token bucket and be
 * swapped, while no-liquidity spam (no Cetus pool) never appears. Degrades to
 * the floor if Cetus is unreachable, so the wallet never breaks.
 */
async function verifiedSet(): Promise<Set<string>> {
  void MIN_LIQUIDITY_USD; // TVL floor is now enforced inside cetusUniverse()
  const { verified } = await cetusUniverse();
  if (verified.size === 0) return VERIFIED_FLOOR;
  const set = new Set(VERIFIED_FLOOR);
  for (const c of verified) set.add(c);
  return set;
}

/** True iff this coin is verified (floor or Cetus registry) → safe to show + convert. */
export async function isVerifiedCoin(coinType: string): Promise<boolean> {
  const n = norm(coinType);
  if (VERIFIED_FLOOR.has(n)) return true;
  return (await verifiedSet()).has(n);
}

/** Filter a list of {coinType,...} to ONLY verified coins (in one set fetch). */
export async function filterVerified<T extends { coinType: string }>(rows: T[]): Promise<T[]> {
  const set = await verifiedSet();
  return rows.filter((r) => set.has(norm(r.coinType)));
}
