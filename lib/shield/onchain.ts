import "server-only";

/**
 * Talise shielded-pool, on-chain config (Workstream C, off-chain infra).
 *
 * Mirrors the env-gated pattern of `lib/yield/onchain.ts`: this entire
 * privacy subsystem (indexer cron, merkle-path service, the `/api/shield/*`
 * routes) is DORMANT until `SHIELD_PKG` is set. Nothing here depends on the
 * package being deployed; an unset `SHIELD_PKG` means `shieldConfigured()`
 * returns false everywhere and every route 503s with "privacy not yet live".
 *
 * The published `talise_privacy` package id is intentionally NOT hard-coded
 * (unlike YIELD_ROUTER), the shielded pool has no mainnet money before the
 * Phase-2 ceremony + audit + legal gates clear (see PRIVACY-BUILD-PLAN.md), so
 * there is no live address to commit. It is supplied entirely via env when a
 * testnet / spike deployment exists.
 *
 *   SHIELD_PKG             , published `talise_privacy` Move package id.
 *   SHIELD_REGISTRY_ID     , shared pool registry (NewPool index / admin caps).
 *   SHIELD_POOL_USDSUI     , the `ShieldedPool<USDsui>` shared object id.
 *   SHIELD_FIRST_CHECKPOINT, checkpoint to begin the event scan from (so the
 *                              indexer doesn't replay all of mainnet history).
 *   SUI_FULLNODE_URL       , JSON-RPC fullnode (shared with the yield routes).
 */

export const SHIELD = {
  /** Published `talise_privacy` Move package. Null = feature dormant. */
  packageId: process.env.SHIELD_PKG ?? null,
  /** Shared pool registry object (per-CoinType NewPool index + admin caps). */
  registryId: process.env.SHIELD_REGISTRY_ID ?? null,
  /** The `ShieldedPool<USDsui>` shared object id. */
  poolUsdsui: process.env.SHIELD_POOL_USDSUI ?? null,
  /**
   * Checkpoint the indexer begins scanning from. The poller advances a
   * per-pipeline cursor in Postgres, so this only bounds the very first run.
   * Parsed lazily so a malformed value degrades to "from genesis" rather than
   * throwing at module load.
   */
  firstCheckpoint: process.env.SHIELD_FIRST_CHECKPOINT ?? null,
  module: "events",
} as const;

/** Mainnet JSON-RPC fullnode (shared with `/api/yield/position`). */
export const SHIELD_RPC =
  process.env.SUI_FULLNODE_URL ?? "https://fullnode.mainnet.sui.io";

/**
 * THE single feature gate. Every route / cron / indexer entrypoint checks
 * this first; when false the privacy subsystem is a no-op. Requires the
 * package id AND the USDsui pool id, without a pool there is no event stream
 * to index and no tree to serve paths from.
 */
export function shieldConfigured(): boolean {
  return !!SHIELD.packageId && !!SHIELD.poolUsdsui;
}

/** Fully-qualified Move event type for a `talise_privacy::events` struct. */
export function shieldEventType(struct: string): string {
  if (!SHIELD.packageId) {
    throw new Error("SHIELD_PKG not set, privacy subsystem is dormant");
  }
  return `${SHIELD.packageId}::${SHIELD.module}::${struct}`;
}

/**
 * Parsed `SHIELD_FIRST_CHECKPOINT` as a decimal string suitable for the
 * `suix_queryEvents` cursor, or null when unset / unparseable.
 */
export function shieldFirstCheckpoint(): string | null {
  const raw = SHIELD.firstCheckpoint;
  if (!raw) return null;
  const n = raw.trim();
  return /^\d+$/.test(n) ? n : null;
}
