import "server-only";

/**
 * Verified Sui MAINNET integration constants for the 4 yield-router venues.
 *
 * Sourced from each protocol's live SDK source / public API (June 2026), NOT
 * from docs literals (which are often stale). See docs/strategy/YIELD-ROUTER.md.
 *
 * RULE (per all four SDK maintainers): do NOT hardcode the UPGRADEABLE package
 * target for Suilend / NAVI / Scallop — they upgrade and publish the current
 * id through their SDK/API at runtime. Hardcode only the STABLE shared-object
 * ids (market / storage / protocol object) below and let the SDK resolve the
 * live package when building txs. AlphaLend's latest package id is read from
 * its SDK constants and bumped on SDK upgrade.
 *
 * This module is READ-side + reference. The deposit/withdraw/rotate PTBs are
 * built by per-venue adapters (Phase-2 work) using these ids + the protocol
 * SDKs; the talise::yield_router Move package brackets rotations.
 */

/** Native Circle USDC on Sui — the unit every venue here supplies. NOT the
 *  deprecated Wormhole wUSDC (`0x5d4b30…::coin::COIN`). */
export const USDC_TYPE =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

export type VenueKey = "suilend" | "navi" | "alphalend" | "scallop";

/** Stable, verified mainnet object ids + receipt types per venue. Package
 *  targets intentionally omitted where the SDK must resolve them at runtime. */
export const VENUE_MAINNET: Record<VenueKey, {
  name: string;
  /** npm SDK that builds the supply/withdraw txs + reads APY. */
  sdk: string;
  /** Stable shared object(s) passed to every call. */
  objects: Record<string, string>;
  /** The receipt/position the position object custodies. */
  receipt: string;
  /** How live supply APY is obtained. */
  apySource: string;
}> = {
  suilend: {
    name: "Suilend",
    sdk: "@suilend/sdk",
    objects: {
      lendingMarketId: "0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1",
      lendingMarketType:
        "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf::suilend::MAIN_POOL",
      // supply/withdraw pass lendingMarketId + a u64 reserveArrayIndex resolved
      // from USDC_TYPE via the SDK (no per-reserve shared object).
    },
    receipt: "Obligation<MAIN_POOL> + owned ObligationOwnerCap<MAIN_POOL>",
    apySource: "reserve.supplyApr / 1e18 (SDK parser depositAprPercent)",
  },
  navi: {
    name: "NAVI",
    sdk: "@naviprotocol/lending",
    objects: {
      // ProtocolPackage is read from NAVI's config API at runtime; storage etc are stable.
      storage: "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe",
      priceOracle: "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef",
      incentiveV2: "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c",
      incentiveV3: "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80",
      usdcPoolId: "0xa3582097b4c57630046c0c49a88bfc6b202a3ec0a9db5597c31765f7563755a8",
      usdcAssetId: "10", // u8
    },
    receipt: "account-based (positions in shared storage); owned AccountCap for contract-owned positions",
    apySource: "open-api pools: currentSupplyRate / 1e27 (proven live)",
  },
  alphalend: {
    name: "AlphaLend",
    sdk: "@alphafi/alphalend-sdk",
    objects: {
      lendingProtocolId: "0x01d9cf05d65fa3a9bb7163095139120e3c4e414dfbab153a49779a7d14010b93",
      marketsTableId: "0x2326d387ba8bb7d24aa4cfa31f9a1e58bf9234b097574afb06c5dfb267df4c2e",
      positionTableId: "0x9923cec7b613e58cc3feec1e8651096ad7970c0b4ef28b805c7d97fe58ff91ba",
      pythStateId: "0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8",
      // native-USDC marketId (u64) resolved at runtime via getMarket (ACTIVE_MARKETS [1,3]).
    },
    receipt: "owned PositionCap (Position tracked in shared protocol)",
    apySource: "market.calculateSupplyApr() (SDK model)",
  },
  scallop: {
    name: "Scallop",
    sdk: "@scallop-io/sui-scallop-sdk",
    objects: {
      marketObject: "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9",
      versionObject: "0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7",
      sUsdcType:
        "0x854950aa624b1df59fe64e630b2ba7c550642e9342267a33061d59fb31582da5::scallop_usdc::SCALLOP_USDC",
      // mint/redeem package resolved by the SDK (upgradeable); asset key "usdc".
    },
    receipt: "owned sUSDC market coin (exchange-rate accruing)",
    apySource: "scallopQuery.getMarketPool('usdc').supplyApy (SDK)",
  },
};

/**
 * Live NAVI USDC supply APY from the open API (proven against mainnet). Returns
 * the total APY as a fraction incl. rewards, or null on failure. The other
 * three venues read APY through their SDKs (added with the adapters); this one
 * is dependency-free so the router has at least one fully-live mainnet venue
 * read today.
 */
export async function fetchNaviUsdcApy(): Promise<number | null> {
  try {
    const res = await fetch("https://open-api.naviprotocol.io/api/navi/pools", {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown };
    const arr = (Array.isArray(body) ? body : body.data) as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(arr)) return null;
    const pool = arr.find(
      (p) => String(p.symbol).toUpperCase() === "USDC" && String(p.coinType ?? "").includes("::usdc::USDC")
    );
    if (!pool) return null;
    // Prefer the rewards-inclusive `apy` (percent); fall back to base rate (RAY 1e27).
    const info = pool.supplyIncentiveApyInfo as { apy?: number } | undefined;
    if (info?.apy != null && Number.isFinite(info.apy)) return info.apy / 100;
    const rate = Number(pool.currentSupplyRate);
    return Number.isFinite(rate) ? rate / 1e27 : null;
  } catch {
    return null;
  }
}

/**
 * Live Scallop USDsui supply APY (fraction) from the Scallop market API.
 * Filters the `pools` list to the USDsui pool by its exact coin type. Returns
 * null on failure so the venue drops out of the comparison rather than showing
 * a stale/fabricated rate. (Verified live against mainnet: ~7% supplyApy.)
 */
export async function fetchScallopUsdsuiApy(): Promise<number | null> {
  try {
    const res = await fetch("https://sdk.api.scallop.io/api/market/migrate", {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { pools?: Array<Record<string, unknown>> };
    const pools = body.pools;
    if (!Array.isArray(pools)) return null;
    const pool = pools.find((p) => String(p.coinType ?? "").includes("::usdsui::USDSUI"));
    if (!pool) return null;
    const apy = Number(pool.supplyApy);
    return Number.isFinite(apy) && apy >= 0 && apy < 5 ? apy : null;
  } catch {
    return null;
  }
}
