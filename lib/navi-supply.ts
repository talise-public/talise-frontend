import "server-only";

import {
  coinWithBalance,
  Transaction,
} from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { NaviAdapter } from "@t2000/sdk";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { USDSUI_TYPE, isUsdsui } from "./usdsui";
import { USDSUI_DECIMALS, sui } from "./sui";
import { memoTtl } from "./perf-cache";

/**
 * NAVI USDsui supply / withdraw — sponsor-friendly PTB builders.
 *
 * Why this exists separately from deepbook-margin.ts: NAVI's protocol
 * registry, supply oracle (Pyth), and reserve metadata all live behind
 * @t2000/sdk's `NaviAdapter`. The adapter's `addSaveToTx` /
 * `addWithdrawToTx` methods append the right MoveCalls onto an existing
 * Transaction — we just need to feed them a sender + a pre-split coin
 * handle (`coinWithBalance` so we never touch the gas coin, which
 * belongs to Onara during the sponsored leg).
 *
 * `NaviAdapter` was made public in @t2000/sdk 2.11 — the earlier
 * private `save` ergonomics that blocked mobile aren't a constraint
 * anymore. With this in place, NAVI is the real default yield venue
 * (live ~5% APY on mainnet) and DeepBook margin USDsui can be
 * de-emphasized until its borrow demand picks up.
 */

// NAVI's adapter keys assets by their `symbol` (mixed case "USDsui"),
// not the uppercased registry key — verified from
// `SUPPORTED_ASSETS.USDsui.symbol` in @t2000/sdk 2.11.
const NAVI_ASSET = "USDsui";

/**
 * Treasury wallet that collects the save / spend-and-save fee. Env-overridable
 * so it can be rotated without a redeploy; defaults to the founder treasury.
 */
export const TREASURY_WALLET =
  process.env.TALISE_TREASURY_WALLET?.trim() ||
  "0xc0bf1c51e44f8cfa4a06f16a2408effa3507ac4582744c7ead56078b5e251a48";

/** Save / spend-and-save treasury fee, in basis points (100 = 1%). */
export const SAVE_TREASURY_FEE_BPS = 100;

let _adapter: NaviAdapter | null = null;
let _adapterReady: Promise<NaviAdapter> | null = null;
let _naviJsonRpcClient: SuiJsonRpcClient | null = null;

/**
 * Dedicated JSON-RPC client for the NAVI SDK. We CANNOT reuse the
 * shared `sui()` (gRPC fallback proxy) here because `@t2000/sdk` 2.11
 * internally calls `client.devInspectTransactionBlock(...)` — a
 * legacy JSON-RPC method that the gRPC proxy doesn't expose. The
 * previous code passed `sui() as never` and the NAVI position read
 * threw `TypeError: t.devInspectTransactionBlock is not a function`,
 * which the withdraw route caught and surfaced to iOS as
 * "Withdraw is taking longer than usual" (since the old withTimeout
 * helper collapsed errors into the timeout fallback). The error
 * mapping in b640a35 already distinguishes timeout vs error; this
 * fix removes the underlying error itself.
 */
function naviJsonRpcClient(): SuiJsonRpcClient {
  if (_naviJsonRpcClient) return _naviJsonRpcClient;
  const url =
    process.env.SUI_JSONRPC_URL?.trim() ||
    "https://fullnode.mainnet.sui.io:443";
  _naviJsonRpcClient = new SuiJsonRpcClient({ url, network: "mainnet" });
  return _naviJsonRpcClient;
}

async function adapter(): Promise<NaviAdapter> {
  if (_adapter) return _adapter;
  if (_adapterReady) return _adapterReady;
  _adapterReady = (async () => {
    const a = new NaviAdapter();
    // Use a dedicated JSON-RPC SuiClient (NOT the gRPC proxy) per the
    // comment above naviJsonRpcClient().
    await a.init(naviJsonRpcClient() as never);
    _adapter = a;
    return a;
  })();
  return _adapterReady;
}

/**
 * Pre-warm the NAVI adapter so the first round-up send doesn't pay the
 * cold-start RPC cost inside `appendNaviSupply`. The adapter's
 * `init()` fetches pool registry + reserve metadata from chain (one
 * fat gRPC round-trip, ~400–900ms cold). After warm, subsequent
 * `adapter()` calls return the cached instance synchronously.
 *
 * Intentionally NOT called at module load (it does RPC and would
 * stall every cold start, including handlers that never touch NAVI).
 * The right place to call it is `/api/zk/warmup`, which iOS hits on
 * dashboard load — so the cost hides behind the user reading their
 * balances, not behind the Send button.
 *
 * Returns true on successful warm, false on any failure (we never let
 * a warmup failure surface to the user; the real send path will
 * re-attempt and surface a clear error if NAVI is genuinely down).
 */
export async function initNaviAdapter(): Promise<boolean> {
  try {
    await adapter();
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a NAVI USDsui supply step onto an existing Transaction.
 * Caller wraps with `tx.setSender(...)` + `onlyTransactionKind: true`
 * before handing to Onara.
 *
 * Uses `coinWithBalance` (not `splitCoins(tx.gas)`) because the gas
 * coin is sponsor-owned in the sponsored flow — splitting from it
 * would have the wallet trying to pay gas with someone else's SUI.
 */
export async function appendNaviSupply(
  tx: Transaction,
  senderAddress: string,
  amountUsdsui: number,
  opts?: {
    /**
     * Treasury fee in basis points skimmed from the supplied amount and sent to
     * {@link TREASURY_WALLET} in the SAME atomic PTB (100 = 1%). Set this ONLY
     * on the save / spend-and-save (round-up) legs; the direct Earn deposit
     * passes nothing (it is the yield product, not a save). Of `amountUsdsui`,
     * `feeBps` goes to the treasury and the remainder is supplied to yield.
     */
    treasuryFeeBps?: number;
  }
): Promise<void> {
  const a = await adapter();
  const onchain = BigInt(Math.round(amountUsdsui * 10 ** USDSUI_DECIMALS));
  if (onchain <= 0n) {
    throw new Error("amount too small");
  }
  const coin = tx.add(
    coinWithBalance({ type: USDSUI_TYPE, balance: onchain, useGasCoin: false })
  );

  // Treasury fee: split `feeBps` off the supply coin and send it to the
  // treasury wallet atomically, then supply the remainder. `splitCoins`
  // mutates `coin` to hold the leftover, so the supply leg gets (100% − fee).
  const feeBps = BigInt(Math.max(0, Math.floor(opts?.treasuryFeeBps ?? 0)));
  if (feeBps > 0n) {
    const fee = (onchain * feeBps) / 10_000n;
    if (fee > 0n) {
      const [feeCoin] = tx.splitCoins(coin, [fee]);
      tx.transferObjects([feeCoin], TREASURY_WALLET);
    }
  }

  await a.addSaveToTx(tx, senderAddress, coin, NAVI_ASSET);
}

/**
 * Build a NAVI USDsui withdraw step. `amount === undefined | <= 0` is
 * treated as "withdraw everything I have supplied" — the adapter
 * resolves the live supplied amount internally.
 *
 * `skipPythUpdate: false` keeps the oracle refresh in the PTB, which
 * NAVI requires for the position health check during withdraw.
 */
export async function appendNaviWithdraw(
  tx: Transaction,
  senderAddress: string,
  amountUsdsui: number | undefined
): Promise<void> {
  const a = await adapter();
  let amount = amountUsdsui ?? 0;
  if (!Number.isFinite(amount) || amount <= 0) {
    // Adapter signature requires a positive amount, so look up the
    // current supplied balance and redeem that exact value. Anything
    // missed (e.g. interest accrued between read and submit) gets
    // picked up on the next withdraw.
    const positions = await a.getPositions(senderAddress);
    const usdsuiSupply = positions.supplies.find(
      (s) => s.asset === NAVI_ASSET || s.asset.toLowerCase() === "usdsui"
    );
    amount = usdsuiSupply?.amount ?? 0;
    if (amount <= 0) {
      throw new Error("no NAVI USDsui position to withdraw");
    }
  }
  const { coin } = await a.addWithdrawToTx(
    tx,
    senderAddress,
    amount,
    NAVI_ASSET
  );
  tx.transferObjects([coin], senderAddress);
}

/**
 * Fetch the live USDsui supply APY from NAVI's public open API.
 *
 * Why this exists: `@t2000/sdk`'s `getFinancialSummary` returns the
 * USDC `saveApy` regardless of the actual reserve asset — its
 * `getRates()` populates `result.USDC.saveApy` but never adds a
 * USDsui key, then `getFinancialSummary` reads `rates.USDC?.saveApy`
 * unconditionally. That caused the iOS Earn screen to render
 * USDC's 5.73% as Navi's USDsui APY when the actual on-portal
 * USDsui figure is 9.18%.
 *
 * `supplyIncentiveApyInfo.apy` is the same number the Navi UI shows
 * (vaultApr + boostedApr from reward tokens). Returned as a
 * fraction (0.0918 for 9.18%) so it slots straight into the
 * existing `YieldVenue.apy` shape.
 *
 * 60s TTL keeps the iOS load fast; Navi APYs change on the order of
 * hours. Returns null on any fetch / parse failure so callers can
 * fall back to the SDK number (still wrong, but better than 0).
 */
const NAVI_POOLS_URL = "https://open-api.naviprotocol.io/api/navi/pools?env=prod";
const NAVI_CONFIG_URL = "https://open-api.naviprotocol.io/api/navi/config?env=prod";

type NaviPoolRow = {
  /** NAVI reserve/asset id (matches the on-chain `UserStateInfo.asset_id`). */
  id: number;
  coinType: string;
  /** Ray-scaled (1e27) supply index — multiply the user's raw scaled
   *  supply balance by this to get the redeemable amount in base units. */
  currentSupplyIndex?: string;
  token?: { decimals?: number; symbol?: string };
  supplyIncentiveApyInfo?: { apy?: string };
};

/**
 * Fetch + cache NAVI's full pool list from the public open API.
 *
 * Shared by the APY read AND the direct position read (below) so a single
 * 60s-cached round-trip serves both — the hot path then only pays for the
 * per-user `devInspect` (~1–2s) instead of re-fetching pool metadata each
 * time. Returns `[]` on any fetch/parse failure so callers degrade to
 * null/0 rather than throwing.
 */
async function fetchNaviPoolsOnce(): Promise<NaviPoolRow[]> {
  try {
    const res = await fetch(NAVI_POOLS_URL, {
      // Don't cache at the fetch layer — memoTtl handles TTL.
      cache: "no-store",
      // Conservative deadline so a slow Navi response doesn't stall
      // the whole /api/yield/comparison handler.
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: NaviPoolRow[] };
    return body?.data ?? [];
  } catch {
    return [];
  }
}

async function fetchNaviPools(): Promise<NaviPoolRow[]> {
  return memoTtl("navi:pools", 60_000, fetchNaviPoolsOnce);
}

function findUsdsuiPool(pools: NaviPoolRow[]): NaviPoolRow | undefined {
  return pools.find(
    (p) => p.coinType && isUsdsui("0x" + p.coinType.replace(/^0x/, ""))
  );
}

export async function fetchNaviUsdsuiSupplyApy(): Promise<number | null> {
  const pools = await fetchNaviPools();
  const row = findUsdsuiPool(pools);
  const apyPct = parseFloat(row?.supplyIncentiveApyInfo?.apy ?? "");
  if (!Number.isFinite(apyPct) || apyPct < 0 || apyPct > 200) return null;
  return apyPct / 100;
}

// ───────────────────────────────────────────────────────────────────
// Direct NAVI position read (no @t2000/sdk).
//
// `@t2000/sdk`'s `NaviAdapter.getPositions()` cost ~4–9s on the hot path
// because it re-initialised the pool registry from chain and routed the
// read through a heavyweight summary. We read the user's USDsui supply
// the SAME way NAVI's own getters do — a single `devInspect` of
// `<uiGetter>::getter_unchecked::get_user_state(storage, address)` — and
// convert with the live pool's supply index + decimals.
//
// `get_user_state` returns `vector<UserStateInfo>` where each row is the
// user's scaled (ray-normalised) per-asset position. The redeemable amount
// is `scaled * currentSupplyIndex / 1e27` (rounded) — but that result is in
// NAVI's INTERNAL 9-decimal normalised accounting precision, NOT the coin's
// native decimals. So human units = base / 10^9, regardless of USDsui being
// a 6-decimal coin.
//
// THIS WAS THE BUG 7f5cc4d shipped: it divided by `token.decimals` (6),
// over-dividing by 10^3 and inflating the position ~1000x (a 0.004646 USDsui
// dust position read as 4.646928 — which is why the Earn screen showed
// ₦6,373.94 / "Earned so far" ₦5,615.68 for what is really a few naira).
// Verified live against `NaviAdapter.getPositions()` (the t2000 adapter,
// which correctly uses 9): base 4_646_928 / 10^9 = 0.004646928 == adapter's
// 0.004646, while / 10^6 = 4.646928 was 1000x too high. NAVI normalises every
// reserve's scaled amount to 9 decimals; that — not the coin precision — is
// the divisor.

type NaviConfig = { uiGetter: string; storage: string };

async function fetchNaviConfigOnce(): Promise<NaviConfig | null> {
  try {
    const res = await fetch(NAVI_CONFIG_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Partial<NaviConfig> };
    const cfg = body?.data;
    if (!cfg?.uiGetter || !cfg?.storage) return null;
    return { uiGetter: cfg.uiGetter, storage: cfg.storage };
  } catch {
    return null;
  }
}

async function fetchNaviConfig(): Promise<NaviConfig | null> {
  return memoTtl("navi:config", 5 * 60_000, fetchNaviConfigOnce);
}

/** On-chain `UserStateInfo` struct returned by `get_user_state`. */
const UserStateInfo = bcs.struct("UserStateInfo", {
  asset_id: bcs.u8(),
  borrow_balance: bcs.u256(),
  supply_balance: bcs.u256(),
});

const RAY = 10n ** 27n;

/**
 * NAVI normalises every reserve's scaled supply/borrow amount to a fixed
 * 9-decimal internal precision, independent of the coin's native decimals.
 * So `rayMul(scaled, index)` is in 9-dp normalised units → divide by 10^9 for
 * human units. (Confirmed against `NaviAdapter.getPositions()`; see the block
 * comment above `readNaviUsdsuiSupply`.)
 */
const NAVI_NORMALIZED_DECIMALS = 9;

/** rayMul: scaled supply balance × supply index ÷ 1e27 (round half-up). */
function rayMul(rawScaled: string, supplyIndex: string): bigint {
  let r: bigint;
  let i: bigint;
  try {
    r = BigInt(rawScaled);
    i = BigInt(supplyIndex);
  } catch {
    return 0n;
  }
  if (r === 0n || i === 0n) return 0n;
  return (r * i + RAY / 2n) / RAY;
}

/**
 * Read the user's redeemable USDsui supply balance (human units) directly
 * from NAVI's on-chain getter. Returns 0 for an empty position and 0 on
 * any failure (never throws into the hot path).
 */
export async function readNaviUsdsuiSupply(address: string): Promise<number> {
  try {
    const [cfg, pools] = await Promise.all([
      fetchNaviConfig(),
      fetchNaviPools(),
    ]);
    const usdsui = findUsdsuiPool(pools);
    if (!cfg || !usdsui) return 0;

    const tx = new Transaction();
    tx.moveCall({
      target: `${cfg.uiGetter}::getter_unchecked::get_user_state`,
      arguments: [tx.object(cfg.storage), tx.pure.address(address)],
    });

    const inspect = await naviJsonRpcClient().devInspectTransactionBlock({
      transactionBlock: tx,
      sender: address,
    });
    const bytes = inspect.results?.[0]?.returnValues?.[0]?.[0];
    if (!bytes) return 0;

    const rows = bcs.vector(UserStateInfo).parse(Uint8Array.from(bytes));
    const row = rows.find((r) => Number(r.asset_id) === Number(usdsui.id));
    if (!row) return 0;

    const base = rayMul(
      String(row.supply_balance),
      String(usdsui.currentSupplyIndex ?? "0")
    );
    // Divide by NAVI's 9-decimal internal normalisation, NOT the coin's native
    // `token.decimals` (6). See the block comment above — using token.decimals
    // here is what inflated the position ~1000x.
    const human = Number(base) / 10 ** NAVI_NORMALIZED_DECIMALS;
    return Number.isFinite(human) && human > 0 ? human : 0;
  } catch {
    return 0;
  }
}

/**
 * Live NAVI USDsui position for `address`, with an estimated "earned"
 * breakdown derived from on-chain activity.
 *
 * Data-source decision (Approach A from the spec):
 *   - `currentValue` comes straight from `NaviAdapter.getPositions()` —
 *     the USDsui supply row's `amount` is the principal-plus-accrued
 *     redeemable balance (Navi accrues interest into the position
 *     in-place; there's no separate accrual ledger exposed via SDK,
 *     and Navi's open API only surfaces pool-level data).
 *   - `principalSupplied` is reconstructed by replaying the user's
 *     on-chain Talise Payment-Kit memos: every invest/withdraw to
 *     `venue=navi` carries a typed memo (`talise/v1|invest|...|venue=navi|...`)
 *     whose `amount` field is the canonical USDsui amount the user
 *     supplied or withdrew. The caller passes the parsed activity list
 *     so we don't double-fetch — the comparison route already has it.
 *   - `earned = max(0, currentValue − principalSupplied)`. The floor at
 *     0 protects against transient gaps (e.g. user supplied 100, then
 *     withdrew 100 → we'd read a near-zero current value but the
 *     activity replay nets to 0; rounding noise could go negative).
 *
 * If we can't determine principal (no activity hits for navi, or the
 * activity feed errored out), `principalSupplied` is returned as
 * `currentValue` so `earned` falls to 0 — better to under-report than
 * accidentally show negative or inflated earnings.
 */
export type NaviPositionDetail = {
  /** Current redeemable USDsui balance. Includes accrued interest. */
  currentValue: number;
  /** Estimated principal supplied (= currentValue − earned). */
  principalSupplied: number;
  /** Real accrued yield = currentValue × apy × (elapsed streak / year). */
  earned: number;
  /** `currentValue × apy / 365` — per-day growth at this APY. */
  dailyEarning: number;
  /** Live USDsui supply APY as a fraction (0.0917 = 9.17%). */
  apy: number;
  /**
   * Epoch-ms the CURRENT earning streak started (the deposit that took the
   * position from 0 → positive; resets on a full withdrawal). null when there's
   * no active position. The client ticks `earned` live from this + apy +
   * currentValue, and projects year-end = currentValue × apy.
   */
  earningSinceMs: number | null;
};

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export async function fetchNaviCurrentValue(address: string): Promise<number> {
  // Direct on-chain read (see `readNaviUsdsuiSupply`) — dropped the
  // @t2000/sdk `NaviAdapter.getPositions()` path, which cost ~4–9s.
  return readNaviUsdsuiSupply(address);
}

/**
 * Compute the NAVI USDsui position breakdown for an address, given a
 * pre-fetched activity feed (the `venue == 'navi'` rows). Returning a
 * function rather than fetching activity here avoids a second
 * `queryTransactionBlocks` round-trip — callers (`/api/yield/comparison`,
 * `/api/earn/withdraw-earned/prepare`) already have or can cheaply
 * fetch the activity list once.
 *
 * Earned-interest derivation strategy:
 *
 *   1. Sum up all `invest`/`withdraw` USDsui amounts seen in activity
 *      to get a NAIVE principal estimate (`naiveNetDeposited`).
 *
 *   2. If `naiveNetDeposited <= currentValue` (the happy case), then
 *      `principalSupplied = naiveNetDeposited` and
 *      `earned = currentValue − principalSupplied`. This matches the
 *      original spec.
 *
 *   3. If `naiveNetDeposited > currentValue` (a real on-chain reality
 *      we observe for users who supply many small USDsui amounts — Navi
 *      internally normalizes USDsui's 6 decimals to its 9-decimal accounting
 *      and rounds dust DOWN on each deposit, so summed-deposits ≥ current
 *      redeemable even before interest), then the naive math under-reports
 *      earned to 0. In that case we fall back to a TIME-WEIGHTED projection:
 *      take the EARLIEST navi invest timestamp as `tFirstSupply` and project
 *      `earned ≈ currentValue × apy × (now − tFirstSupply) / 365d`. We also
 *      clamp `principalSupplied = max(0, currentValue − earned)` so the
 *      iOS UI's "Supplied + Earned ≈ Current" invariant holds.
 *
 *      Projected earned is intentionally MODEST: capped at 10% of
 *      currentValue, so it can't run away if the user's first supply was
 *      ages ago. iOS labels this as "estimated" via the dailyEarning row
 *      regardless, so a small projection is honest.
 *
 *   4. If we couldn't find ANY navi activity (sawAny=false), keep the old
 *      conservative behaviour: principalSupplied = currentValue, earned = 0.
 */
export function naviPositionFromActivity(opts: {
  currentValue: number;
  apy: number;
  naviActivity: Array<{
    direction: "invest" | "withdraw" | string;
    venue: string | null;
    amountUsdsui: number | null;
    /** Optional; used by the time-weighted projection fallback. */
    timestampMs?: number;
  }>;
}): NaviPositionDetail {
  const { currentValue, apy } = opts;
  const dailyEarning = currentValue * apy / 365;

  // Replay NAVI invests/withdraws in CHRONOLOGICAL order, tracking a running
  // net balance, to find when the CURRENT earning streak began. The streak
  // starts when the balance crosses 0 → positive, and RESETS on a full
  // withdrawal. So deposit/withdraw churn can't inflate earnings: fully
  // cashing out and re-depositing restarts the clock from now.
  const rows = opts.naviActivity
    .filter(
      (r) =>
        (r.venue ?? "").toLowerCase() === "navi" &&
        Math.abs(r.amountUsdsui ?? 0) > 0 &&
        (r.direction === "invest" || r.direction === "withdraw")
    )
    .map((r) => ({
      dir: r.direction,
      amt: Math.abs(r.amountUsdsui ?? 0),
      ts: r.timestampMs ?? 0,
    }))
    .sort((a, b) => a.ts - b.ts);

  const EPS = 1e-9;
  let bal = 0;
  let streakStart: number | null = null;
  for (const r of rows) {
    if (r.dir === "invest") {
      // 0 → positive: a (re)start of the earning streak.
      if (bal <= EPS && r.ts > 0) streakStart = r.ts;
      bal += r.amt;
    } else {
      bal -= r.amt;
      if (bal <= EPS) {
        bal = 0;
        streakStart = null; // fully withdrawn → streak ends, clock resets
      }
    }
  }

  // Real accrued yield = current balance × APY × (time held this streak).
  // No artificial cap/floor games — the streak reset is what keeps it honest;
  // a single sanity clamp at 100% guards against bad activity data only. The
  // client re-derives + ticks this live from `earningSinceMs`.
  let earned = 0;
  if (streakStart && streakStart > 0 && apy > 0 && currentValue > 0) {
    const elapsed = Math.max(0, Date.now() - streakStart);
    earned = Math.min(currentValue, currentValue * apy * (elapsed / YEAR_MS));
  }

  return {
    currentValue,
    principalSupplied: Math.max(0, currentValue - earned),
    earned,
    dailyEarning,
    apy,
    earningSinceMs: streakStart,
  };
}
