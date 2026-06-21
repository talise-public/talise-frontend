import "server-only";

/**
 * Live Sui MAINNET deployment of `talise_yield::yield_router`.
 *
 * Published 2026-06-16 from the Talise deployer (angry-apatite).
 *   publish tx: 8zmjMcArWx5wfDw35uPQUTCuVwBVi85k1bGq8k1CwnqX
 *
 * Kept as its OWN package (not folded into `talise`) so it ships
 * independently of the pending cheque-v2 / vault mainnet publish.
 * Override via env in case of an upgrade (the package is upgradeable via
 * the UpgradeCap the deployer holds).
 */
export const YIELD_ROUTER = {
  /** Published Move package. */
  packageId:
    process.env.TALISE_YIELD_PACKAGE_ID ??
    "0xa58f2dee1dd01ac655ef2d9180a96228ab4667219049cfc1286752b3923ad730",
  /** Shared RebalanceRegistry (keeper allowlist + venue circuit breaker). */
  registryId:
    process.env.TALISE_YIELD_REGISTRY_ID ??
    "0x9ba71e5164254040f60a439abb7317670a90437b3603a22ca3eceac92c3d7e21",
  module: "yield_router",
} as const;

export const yieldRouterTarget = (fn: string) =>
  `${YIELD_ROUTER.packageId}::${YIELD_ROUTER.module}::${fn}` as const;
