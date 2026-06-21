import "server-only";

import { USDSUI_TYPE } from "@/lib/usdsui";
import { memoTtl } from "@/lib/perf-cache";

/**
 * COIN VERIFICATION — the single gate for which coins Talise shows + offers to
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

/** A coin must have at least this much on-chain liquidity to be convertible —
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
 * Always-verified floor — coins we KNOW are Cetus-verified with deep liquidity,
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
 * The full verified set: the floor PLUS Cetus's published verified-token list
 * (cached 1h, best-effort). `CETUS_TOKEN_LIST_URL` configures the registry
 * endpoint; if unset or the fetch fails, we degrade to the floor — which already
 * ignores all spam, so the feature is correct either way.
 */
async function verifiedSet(): Promise<Set<string>> {
  const url = process.env.CETUS_TOKEN_LIST_URL;
  if (!url) return VERIFIED_FLOOR;
  return memoTtl("cetus:verified-coins", 60 * 60 * 1000, async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return VERIFIED_FLOOR;
      const j = (await res.json()) as unknown;
      // Tolerate the common Cetus shapes: a flat array or { tokens|data|list: [...] }.
      const arr: Array<Record<string, unknown>> = Array.isArray(j)
        ? (j as Array<Record<string, unknown>>)
        : ((j as Record<string, unknown[]>)?.tokens ??
            (j as Record<string, unknown[]>)?.data ??
            (j as Record<string, unknown[]>)?.list ??
            []) as Array<Record<string, unknown>>;
      const set = new Set(VERIFIED_FLOOR);
      for (const t of arr) {
        const ct = (t.coin_type ?? t.coinType ?? t.address ?? t.type) as string | undefined;
        const verified = (t.verified ?? t.is_verified ?? t.isVerified ?? true) as boolean;
        // LOW-LIQUIDITY GUARD: even a "verified" coin is ignored if its pool
        // liquidity/TVL is below the floor (when the registry exposes it) — a
        // thin coin's swap fails. Unknown liquidity → trust the verified flag.
        const liq = Number(t.liquidity ?? t.liquidityUsd ?? t.tvl ?? t.tvlUsd ?? NaN);
        const liquidEnough = Number.isNaN(liq) || liq >= MIN_LIQUIDITY_USD;
        if (ct && verified && liquidEnough) set.add(norm(ct));
      }
      return set;
    } catch {
      return VERIFIED_FLOOR;
    }
  });
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
