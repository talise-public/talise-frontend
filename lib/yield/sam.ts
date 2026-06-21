import "server-only";

import { Transaction } from "@mysten/sui/transactions";
import { sui } from "@/lib/sui";

/**
 * SAM (usesam.xyz) yield-vault adapter.
 *
 * SAM is a non-custodial Sui yield vault: deposit USDC → receive an
 * appreciating share coin (samUSDC) representing a pro-rata claim on a pool
 * that SAM auto-allocates across Scallop / Suilend / NAVI and compounds reward
 * tokens. Yield accrues purely via SHARE PRICE (pool value C ÷ shares S) — no
 * rebasing, no claiming, no lock-up; redeem any time in one tx. SAM is the
 * "engine of engines": it does multi-market aggregation + rebalancing +
 * reward harvesting, so Talise routes idle dollars INTO it rather than
 * rebuilding that. Fees: 0% deposit, 0.01% withdraw, 10% performance (on
 * harvested yield only, never principal). Docs: https://docs.usesam.xyz
 *
 * ── ENV-GATED, like every Talise partner ──────────────────────────────────
 * SAM's public docs are user/math-only — they do NOT publish the package id,
 * module, entry-function names, share-coin type, or vault object id. So this
 * adapter is fully configured by env and is DORMANT until those are set:
 * `samConfigured()` is false → reads return null, build* throw a clear error,
 * so nothing ever executes against SAM with guessed identifiers.
 *
 *   SAM_PACKAGE_ID      published Move package id (0x…)
 *   SAM_MODULE          vault module name (default "vault")
 *   SAM_DEPOSIT_FN      deposit entry fn (default "deposit")
 *   SAM_REDEEM_FN       redeem entry fn (default "redeem")
 *   SAM_USDC_VAULT_ID   the shared USDC vault object id
 *   SAM_USDC_SHARE_TYPE fully-qualified samUSDC coin type (0x…::sam::SAM_USDC)
 *   SAM_USDC_COIN_TYPE  the vault's underlying USDC coin type
 *
 * Fill these from SAM's published interface (or a decoded mainnet deposit tx),
 * then `samConfigured()` flips true and the venue goes live.
 */

export type SamConfig = {
  packageId: string;
  module: string;
  depositFn: string;
  redeemFn: string;
  vaultId: string;
  shareType: string;
  underlyingType: string;
};

export function samConfig(): SamConfig | null {
  const packageId = process.env.SAM_PACKAGE_ID;
  const vaultId = process.env.SAM_USDC_VAULT_ID;
  const shareType = process.env.SAM_USDC_SHARE_TYPE;
  const underlyingType = process.env.SAM_USDC_COIN_TYPE;
  if (!packageId || !vaultId || !shareType || !underlyingType) return null;
  return {
    packageId,
    module: process.env.SAM_MODULE || "vault",
    depositFn: process.env.SAM_DEPOSIT_FN || "deposit",
    redeemFn: process.env.SAM_REDEEM_FN || "redeem",
    vaultId,
    shareType,
    underlyingType,
  };
}

export function samConfigured(): boolean {
  return samConfig() !== null;
}

// ── Share math (verbatim from docs.usesam.xyz/math) ──────────────────────
//
// Pure, exact, and correct regardless of the on-chain wiring — this is the
// honest-accounting core of the engine. All rounding is DOWN on user-facing
// amounts (SAM's anti-gaming rule); fees round UP.

/** SAM fee schedule (bps). Deposit currently waived; withdraw 1bp; perf 10%. */
export const SAM_FEES = { depositBps: 0, withdrawBps: 1, performanceBps: 1000 } as const;

/** Price per share = pool value C ÷ share supply S (1.0 when empty). */
export function sharePrice(C: number, S: number): number {
  if (S <= 0 || C <= 0) return 1;
  return C / S;
}

/** Shares minted for a NET deposit `a`: ⌊a·S/C⌋ (or `a` when the pool is empty). */
export function sharesForDeposit(a: number, C: number, S: number): number {
  if (a <= 0) return 0;
  if (S <= 0 || C <= 0) return Math.floor(a);
  return Math.floor((a * S) / C);
}

/** Underlying returned for redeeming `s` shares: ⌊s·C/S⌋. */
export function underlyingForShares(s: number, C: number, S: number): number {
  if (s <= 0 || S <= 0) return 0;
  return Math.floor((s * C) / S);
}

/** Withdraw fee (ceiling) on an outgoing amount. */
export function withdrawFee(out: number): number {
  return Math.ceil((out * SAM_FEES.withdrawBps) / 10_000);
}

/** Value of a share balance at the current pool state, net of withdraw fee. */
export function positionValue(shareBalance: number, C: number, S: number): {
  gross: number;
  fee: number;
  net: number;
} {
  const gross = underlyingForShares(shareBalance, C, S);
  const fee = withdrawFee(gross);
  return { gross, fee, net: Math.max(0, gross - fee) };
}

// ── Vault state + position reads ─────────────────────────────────────────

export type SamVaultState = {
  /** Pool value C (underlying units). */
  totalValue: number;
  /** Share supply S. */
  totalShares: number;
  /** C ÷ S. */
  price: number;
};

/**
 * Read the SAM vault's C (pool value) and S (share supply) from its shared
 * object. The FIELD PATHS depend on SAM's struct layout, which the docs don't
 * publish — `SAM_VAULT_VALUE_FIELD` / `SAM_VAULT_SHARES_FIELD` override the
 * defaults once known. Returns null when unconfigured or unreadable (callers
 * degrade gracefully).
 */
export async function fetchSamVaultState(): Promise<SamVaultState | null> {
  const cfg = samConfig();
  if (!cfg) return null;
  try {
    const obj = (await sui().getObject({
      id: cfg.vaultId,
      options: { showContent: true },
    } as never)) as { data?: { content?: { fields?: Record<string, unknown> } } };
    const fields = obj.data?.content?.fields;
    if (!fields) return null;
    const valueField = process.env.SAM_VAULT_VALUE_FIELD || "total_value";
    const sharesField = process.env.SAM_VAULT_SHARES_FIELD || "total_shares";
    const totalValue = Number(fields[valueField] ?? 0);
    const totalShares = Number(fields[sharesField] ?? 0);
    if (!Number.isFinite(totalValue) || !Number.isFinite(totalShares)) return null;
    return { totalValue, totalShares, price: sharePrice(totalValue, totalShares) };
  } catch {
    return null;
  }
}

/**
 * A user's SAM position: their samUSDC share balance × current share price,
 * net of the withdraw fee. `earned` is derived against a caller-supplied cost
 * basis (Talise tracks deposit basis in its ledger), so it's honest and
 * churn-proof — exactly the model SAM documents.
 */
export async function readSamPosition(
  address: string,
  costBasis?: number
): Promise<{ shares: number; value: number; earned: number } | null> {
  const cfg = samConfig();
  if (!cfg) return null;
  const [state, balance] = await Promise.all([
    fetchSamVaultState(),
    sui()
      .getBalance({ owner: address, coinType: cfg.shareType } as never)
      .then((b: unknown) => Number((b as { totalBalance?: string }).totalBalance ?? 0))
      .catch(() => 0),
  ]);
  if (!state) return null;
  const { net } = positionValue(balance, state.totalValue, state.totalShares);
  const earned = costBasis != null ? Math.max(0, net - costBasis) : 0;
  return { shares: balance, value: net, earned };
}

/**
 * The vault's offered APY as a fraction (0.09 = 9%). SAM surfaces this on its
 * vault object; the field name isn't published, so `SAM_VAULT_APY_FIELD`
 * overrides the default. Returns null when unconfigured / unknown so the venue
 * stays out of the comparison rather than showing a fabricated rate.
 */
export async function fetchSamApy(): Promise<number | null> {
  const cfg = samConfig();
  if (!cfg) return null;
  try {
    const obj = (await sui().getObject({
      id: cfg.vaultId,
      options: { showContent: true },
    } as never)) as { data?: { content?: { fields?: Record<string, unknown> } } };
    const fields = obj.data?.content?.fields;
    const apyField = process.env.SAM_VAULT_APY_FIELD;
    if (!fields || !apyField) return null; // no known APY field → stay dormant
    // SAM expresses rates Fixed18 (1e18 = 100%); accept a fraction too.
    const raw = Number(fields[apyField] ?? NaN);
    if (!Number.isFinite(raw) || raw < 0) return null;
    const apy = raw > 1 ? raw / 1e18 : raw;
    return apy >= 0 && apy < 5 ? apy : null; // sanity clamp (<500%)
  } catch {
    return null;
  }
}

// ── PTB step builders ────────────────────────────────────────────────────
//
// Append a SAM deposit/redeem onto an existing sponsored Transaction. They
// THROW when SAM isn't configured so a half-wired env can never execute a
// guessed Move call. Exact arg order may need adjusting to SAM's signature —
// kept minimal (vault, coin/shares) per the documented deposit/redeem shape.

/** Deposit `usdcCoin` (a Coin<USDC> argument) into the SAM vault; shares to sender. */
export function buildSamDeposit(
  tx: Transaction,
  usdcCoin: ReturnType<Transaction["object"]>
): void {
  const cfg = samConfig();
  if (!cfg) throw new Error("SAM not configured (SAM_PACKAGE_ID / vault / types)");
  const shares = tx.moveCall({
    target: `${cfg.packageId}::${cfg.module}::${cfg.depositFn}`,
    typeArguments: [cfg.underlyingType],
    arguments: [tx.object(cfg.vaultId), usdcCoin],
  });
  tx.transferObjects([shares], tx.pure.address("@sender" as never));
}

/** Redeem `shareCoin` (a Coin<samUSDC>) from the SAM vault; USDC back to sender. */
export function buildSamRedeem(
  tx: Transaction,
  shareCoin: ReturnType<Transaction["object"]>
): void {
  const cfg = samConfig();
  if (!cfg) throw new Error("SAM not configured (SAM_PACKAGE_ID / vault / types)");
  const out = tx.moveCall({
    target: `${cfg.packageId}::${cfg.module}::${cfg.redeemFn}`,
    typeArguments: [cfg.underlyingType],
    arguments: [tx.object(cfg.vaultId), shareCoin],
  });
  tx.transferObjects([out], tx.pure.address("@sender" as never));
}
