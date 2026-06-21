import "server-only";

import { Transaction, type TransactionObjectArgument } from "@mysten/sui/transactions";
import { USDSUI_TYPE } from "../usdsui";

/**
 * On-chain PTB builders for supplying / redeeming USDsui across the 4 router
 * venues. ALL FOUR list USDsui directly (verified on mainnet 2026-06-16), so
 * there is NO USDsui→USDC swap — we route the Sui Dollar straight in.
 *
 * Each builder APPENDS move calls onto a caller-provided Transaction (the
 * sponsored-send / keeper path owns signing + gas) and returns the venue
 * RECEIPT handle where one exists, so the caller can hand it to
 * `talise::yield_router::deposit_receipt` / `end_rotation`.
 *
 * Receipt models differ (this drives what the YieldPosition custodies):
 *   • Suilend  → `Coin<CToken<MAIN_POOL, USDSUI>>`        (coin receipt)
 *   • Scallop  → `Coin<SCALLOP_USDSUI>` (sUSDsui)          (coin receipt)
 *   • NAVI     → `AccountCap` (positions live in shared Storage)  (cap receipt)
 *   • AlphaLend→ `PositionCap` (collateral in shared Position)    (cap receipt)
 *
 * VERIFY-BEFORE-MAINNET: the upgradeable package targets (NAVI / Suilend /
 * Scallop) move on upgrades — resolve the live id via each SDK or a devInspect
 * before a real-fund tx. The shared object ids below are stable. Per the
 * standing rule, dry-run every builder with `devInspect` first.
 */

const CLOCK = "0x6";
const SYSTEM_STATE = "0x5";

// ── NAVI ────────────────────────────────────────────────────────────────
// USDsui = assetId 34. Account-based: we use the AccountCap variant so the
// position is owned by a storable cap the YieldPosition can custody.
const NAVI = {
  pkg: "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb", // resolve latest via SDK
  storage: "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe",
  oracle: "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef",
  incentiveV2: "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c",
  incentiveV3: "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80",
  usdsuiPool: "0xb0da1bf1702e919a3d5182939944435ccfd1b1facd92acb273007c3f09f42201",
  usdsuiAssetId: 34,
} as const;

/** Create a NAVI AccountCap (the storable position handle). Call once per
 *  position; store the returned cap in the YieldPosition. */
export function buildNaviCreateAccount(tx: Transaction): TransactionObjectArgument {
  return tx.moveCall({ target: `${NAVI.pkg}::lending::create_account` });
}

/** Supply `usdsuiCoin` to NAVI under `accountCap`. */
export function buildNaviSupply(
  tx: Transaction,
  accountCap: TransactionObjectArgument,
  usdsuiCoin: TransactionObjectArgument,
  amount: bigint,
): void {
  tx.moveCall({
    target: `${NAVI.pkg}::incentive_v3::deposit_with_account_cap`,
    typeArguments: [USDSUI_TYPE],
    arguments: [
      tx.object(CLOCK),
      tx.object(NAVI.storage),
      tx.object(NAVI.usdsuiPool),
      tx.pure.u8(NAVI.usdsuiAssetId),
      usdsuiCoin,
      tx.object(NAVI.incentiveV2),
      tx.object(NAVI.incentiveV3),
      accountCap,
    ],
  });
}

/** Withdraw `amount` USDsui from NAVI; returns a `Coin<USDSUI>`. */
export function buildNaviWithdraw(
  tx: Transaction,
  accountCap: TransactionObjectArgument,
  amount: bigint,
): TransactionObjectArgument {
  return tx.moveCall({
    target: `${NAVI.pkg}::incentive_v3::withdraw_with_account_cap`,
    typeArguments: [USDSUI_TYPE],
    arguments: [
      tx.object(CLOCK),
      tx.object(NAVI.oracle),
      tx.object(NAVI.storage),
      tx.object(NAVI.usdsuiPool),
      tx.pure.u8(NAVI.usdsuiAssetId),
      tx.pure.u64(amount),
      tx.object(NAVI.incentiveV2),
      tx.object(NAVI.incentiveV3),
      accountCap,
    ],
  });
}

// ── Scallop ─────────────────────────────────────────────────────────────
// Cleanest model: supply returns a transferable sUSDsui coin (the receipt).
const SCALLOP = {
  pkg: "0x578374a1f5182013268bbe9b2b080c5d14cbed1a48f9990c5f8a1c33bf100e69", // resolve latest via SDK
  market: "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9",
  version: "0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7",
  sUsdsuiType:
    "0x4dc741a062c216e7ac1c47a4034a8941112a5aa5516c128da10f0be2397e836d::scallop_usdsui::SCALLOP_USDSUI",
} as const;
export const SCALLOP_SUSDSUI_TYPE = SCALLOP.sUsdsuiType;

/**
 * Scallop supply is DISABLED: the pinned `version` object above is stale vs
 * Scallop's current protocol version, so `mint::mint` aborts in
 * `version::assert_current_version` (code 513) and every supply reverts on
 * chain. Until we resolve the live version object via Scallop's SDK, deposits
 * route to NAVI (live, works). Flip back to `true` once `SCALLOP.version`
 * (and pkg, if upgraded) are refreshed to the current on-chain values.
 */
export const SCALLOP_SUPPLY_ENABLED = false;

/** Supply `usdsuiCoin` to Scallop; returns the `Coin<SCALLOP_USDSUI>` receipt. */
export function buildScallopSupply(
  tx: Transaction,
  usdsuiCoin: TransactionObjectArgument,
): TransactionObjectArgument {
  return tx.moveCall({
    target: `${SCALLOP.pkg}::mint::mint`,
    typeArguments: [USDSUI_TYPE],
    arguments: [tx.object(SCALLOP.version), tx.object(SCALLOP.market), usdsuiCoin, tx.object(CLOCK)],
  });
}

/** Redeem a `Coin<SCALLOP_USDSUI>` back to `Coin<USDSUI>`. */
export function buildScallopRedeem(
  tx: Transaction,
  sUsdsuiCoin: TransactionObjectArgument,
): TransactionObjectArgument {
  return tx.moveCall({
    target: `${SCALLOP.pkg}::redeem::redeem`,
    typeArguments: [USDSUI_TYPE],
    arguments: [tx.object(SCALLOP.version), tx.object(SCALLOP.market), sUsdsuiCoin, tx.object(CLOCK)],
  });
}

// ── Suilend ─────────────────────────────────────────────────────────────
// USDsui = reserveArrayIndex 44. Supply mints cTokens (the receipt) — for
// pure supply-to-earn we hold the cToken; collateral/obligation is optional.
const SUILEND = {
  pkg: "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf", // resolve PUBLISHED_AT via SDK
  market: "0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1",
  marketType:
    "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf::suilend::MAIN_POOL",
  usdsuiReserveIndex: 44,
} as const;

/** Supply `usdsuiCoin` to Suilend; returns the `Coin<CToken<MAIN_POOL, USDSUI>>`. */
export function buildSuilendSupply(
  tx: Transaction,
  usdsuiCoin: TransactionObjectArgument,
): TransactionObjectArgument {
  return tx.moveCall({
    target: `${SUILEND.pkg}::lending_market::deposit_liquidity_and_mint_ctokens`,
    typeArguments: [SUILEND.marketType, USDSUI_TYPE],
    arguments: [
      tx.object(SUILEND.market),
      tx.pure.u64(SUILEND.usdsuiReserveIndex),
      tx.object(CLOCK),
      usdsuiCoin,
    ],
  });
}

/** Redeem cTokens back to `Coin<USDSUI>` (liquidity request → withdraw). */
export function buildSuilendRedeem(
  tx: Transaction,
  ctokens: TransactionObjectArgument,
): TransactionObjectArgument {
  return tx.moveCall({
    target: `${SUILEND.pkg}::lending_market::redeem_ctokens_and_withdraw_liquidity`,
    typeArguments: [SUILEND.marketType, USDSUI_TYPE],
    arguments: [
      tx.object(SUILEND.market),
      tx.pure.u64(SUILEND.usdsuiReserveIndex),
      tx.object(CLOCK),
      ctokens,
    ],
  });
}

// ── AlphaLend ───────────────────────────────────────────────────────────
// USDsui = marketId 33. Needs a PositionCap (create once) and — on withdraw —
// a Pyth price update + promise settlement. Supply is straightforward.
const ALPHALEND = {
  pkg: "0xe48b33ef41d56e04fc42bf558e4d54d7cae8a363da9054a6c24bafc2c53a4f33",
  protocol: "0x01d9cf05d65fa3a9bb7163095139120e3c4e414dfbab153a49779a7d14010b93",
  usdsuiMarketId: 33,
} as const;

/** Mint an AlphaLend PositionCap (the storable position handle). Once per position. */
export function buildAlphalendCreatePosition(tx: Transaction): TransactionObjectArgument {
  return tx.moveCall({ target: `${ALPHALEND.pkg}::alpha_lending::create_position` });
}

/** Supply `usdsuiCoin` to AlphaLend market 33 under `positionCap`. */
export function buildAlphalendSupply(
  tx: Transaction,
  positionCap: TransactionObjectArgument,
  usdsuiCoin: TransactionObjectArgument,
): void {
  tx.moveCall({
    target: `${ALPHALEND.pkg}::alpha_lending::add_collateral`,
    typeArguments: [USDSUI_TYPE],
    arguments: [
      tx.object(ALPHALEND.protocol),
      positionCap,
      tx.pure.u64(ALPHALEND.usdsuiMarketId),
      usdsuiCoin,
      tx.object(CLOCK),
    ],
  });
}

// AlphaLend withdraw is intentionally omitted from v1: it returns a "promise"
// hot potato that must be settled with `fulfill_promise` AFTER a Pyth
// `updatePrices` call in the same PTB. Add it alongside the Pyth wiring when
// AlphaLend becomes a withdraw target (it's the capped/growth venue, so
// deposits land here but rotations primarily move OUT via NAVI/Scallop first).

/** Venue id mapping that matches `talise::yield_router` venue constants. */
export const VENUE_ID = { suilend: 1, navi: 2, alphalend: 3, scallop: 4 } as const;
