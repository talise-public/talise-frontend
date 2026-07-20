import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import {
  getSuiBalance,
  getUsdsuiBalanceStrict,
  USDSUI_DECIMALS,
  USDSUI_TYPE,
} from "@/lib/sui";
import { suiGrpcBroadcast } from "@/lib/sui-endpoints";
import { getSuiUsdcPrice } from "@/lib/deepbook";
import { memoTtl } from "@/lib/perf-cache";
import {
  readBalanceSnapshot,
  writeBalanceSnapshot,
  getGlobalNum,
  setGlobalNum,
  refreshInBackground,
} from "@/lib/snapshots";
import {
  gql,
  BAG_DYNAMIC_FIELDS_QUERY,
  decodeBagKeyVectorU8,
  type GraphQLBagDynamicFieldsResponse,
  type GraphQLVaultAndCapsResponse,
  VAULT_AND_CAPS_QUERY,
} from "@/lib/sui-graphql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SUI/USD spot is a global value, every user sees the same number, so
 * cache it process-wide. DeepBook level-2 quotes cost 800-2000ms; serving
 * a 45s-old price is fine for a balance display (the headline number is
 * USDsui anyway, and the SUI side is sweep-banner UX). With this cache,
 * the price slot effectively never trips the 600ms timeout below.
 */
const PRICE_CACHE_TTL_MS = 45_000;
function cachedSuiUsdcPrice(): Promise<number> {
  return memoTtl("sui-usdc-price", PRICE_CACHE_TTL_MS, () =>
    getSuiUsdcPrice().catch(() => 0)
  );
}

// ───────────────────────────────────────────────────────────────────
// Vault contents fold-in
//
// The auto-swap vault sits on a shared `TaliseVault` Move object whose
// `balances` field is a `Bag<vector<u8>, Balance<T>>`. Coin types written
// by Move's `type_name::get<T>()` arrive in the FULL canonical form
//   "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
// (no `0x`, address left-padded to 64 hex chars). Wallet RPC calls, and
// our `USDSUI_TYPE` constant, use the SHORT form
//   "0x44f838…::usdsui::USDSUI"
// So we canonicalize both sides before comparing. We keep the SHORT form
// (matches `USDSUI_TYPE`, `0x2::sui::SUI`, the Sui SDK default, and what
// the iOS app would see if it ever asked for the breakdown, which it
// currently doesn't, but the response shape stays consistent).

/**
 * Normalize a Move type tag to short form: lowercase, drop the `0x`
 * prefix on the address half, strip leading zeros (keeping one), then
 * re-add `0x`. `<addr>::module::Name` shape only, anything else returns
 * unchanged.
 */
function canonicalizeTypeTag(t: string): string {
  const idx = t.indexOf("::");
  if (idx < 0) return t;
  let addr = t.slice(0, idx);
  const tail = t.slice(idx);
  if (addr.startsWith("0x") || addr.startsWith("0X")) addr = addr.slice(2);
  addr = addr.toLowerCase().replace(/^0+/, "") || "0";
  return `0x${addr}${tail}`;
}

const SUI_TYPE_SHORT = "0x2::sui::SUI";
const USDSUI_TYPE_SHORT = canonicalizeTypeTag(USDSUI_TYPE);

/** Sum of vault Balance<T> entries scaled into wallet-equivalent units. */
type VaultTotals = {
  /** Vault contribution to the `usdsui` field (human-scaled). */
  usdsui: number;
  /** Vault contribution to the `sui` field (human-scaled). */
  sui: number;
};

/** Extract the bag UID from the vault Move struct's `contents.json`. */
function extractBagId(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const balances = (json as { balances?: unknown }).balances;
  if (!balances || typeof balances !== "object") return undefined;
  const id = (balances as { id?: unknown }).id;
  if (!id || typeof id !== "object") return undefined;
  const inner = (id as { id?: unknown }).id;
  return typeof inner === "string" ? inner : undefined;
}

/** Pull the u64 `value` out of a Balance<T>'s json (string or number). */
function extractBalanceValue(json: unknown): bigint {
  if (!json || typeof json !== "object") return 0n;
  const v = (json as { value?: unknown }).value;
  try {
    if (typeof v === "string") return BigInt(v);
    if (typeof v === "number") return BigInt(v);
  } catch {
    /* fall through */
  }
  return 0n;
}

/**
 * Read the vault's Bag<vector<u8>, Balance<T>> and fold SUI/USDsui
 * entries into wallet-equivalent totals. Other coin types are ignored
 * for `totalUsd` because the wallet path doesn't price arbitrary coins
 * either, keeping symmetry.
 *
 * 10s memo matches `/api/vault/state` (the bag is also re-read there;
 * underlying GraphQL responses share a process-wide cache anyway, so
 * a hit here usually doesn't even hit the wire).
 */
async function readVaultTotals(vaultId: string): Promise<VaultTotals> {
  return memoTtl(`vault-balances:${vaultId}`, 10_000, async () => {
    const totals: VaultTotals = { usdsui: 0, sui: 0 };

    // Step 1, vault contents to discover the bag UID. Reuses the
    // existing query so the GraphQL cache is shared with /api/vault/state.
    const headData = await gql<GraphQLVaultAndCapsResponse>(
      VAULT_AND_CAPS_QUERY,
      {
        vaultId,
        // owner / capType are required by the schema but irrelevant here;
        // pass the vault id as owner (a benign SuiAddress) and a type-
        // prefix that yields zero matches. The owner branch is dropped.
        owner: vaultId,
        capType: "0x0::__balances_route_unused__::Sentinel",
        first: 1,
        afterObj: null,
      }
    );
    const bagId = extractBagId(headData.vault?.asMoveObject?.contents?.json);
    if (!bagId) return totals;

    // Step 2, walk the bag's dynamic fields, fold matching coin types.
    let cursor: string | null = null;
    do {
      const data: GraphQLBagDynamicFieldsResponse =
        await gql<GraphQLBagDynamicFieldsResponse>(BAG_DYNAMIC_FIELDS_QUERY, {
          bagId,
          first: 50,
          after: cursor,
        });
      const conn = data.address?.dynamicFields;
      if (!conn) break;
      for (const node of conn.nodes ?? []) {
        const rawType = decodeBagKeyVectorU8(node.name.json);
        if (!rawType) continue;
        const coinType = canonicalizeTypeTag(rawType);
        let amount = 0n;
        if (node.value && node.value.__typename === "MoveValue") {
          amount = extractBalanceValue(node.value.json);
        } else if (node.value && node.value.__typename === "MoveObject") {
          amount = extractBalanceValue(node.value.contents?.json);
        }
        if (amount === 0n) continue;
        if (coinType === USDSUI_TYPE_SHORT) {
          totals.usdsui += Number(amount) / Math.pow(10, USDSUI_DECIMALS);
        } else if (coinType === SUI_TYPE_SHORT) {
          totals.sui += Number(amount) / 1e9;
        }
        // Other types: no wallet-side conversion path, so they don't
        // contribute to `totalUsd`. The cron sweeps them into USDsui
        // before they linger long enough to matter.
      }
      cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (cursor);

    return totals;
  });
}

/**
 * GET /api/balances, wallet + vault balance snapshot for the authed user.
 *
 * Critical path is USDsui (the only unit iOS displays). SUI balance +
 * spot price are returned alongside but populated in the background -
 * the sweep banner / future flows use them, but they shouldn't gate
 * the headline number.
 *
 * Latency profile on mainnet (measured):
 *   getUsdsuiBalance:   ~600-1800ms (one sui_getBalance call)
 *   getSuiBalance:      ~400-800ms  (one sui_getBalance call)
 *   getSuiUsdcPrice:    ~800-2000ms (DeepBook level-2 quote)
 *   readVaultTotals:    ~300-800ms  (2 GraphQL hits, 10s memo)
 *
 * The vault read runs alongside the wallet reads. If the vault read
 * fails for any reason we log and return wallet-only totals, a vault
 * hiccup should never 500 the headline-balance endpoint.
 */
// ───────────────────────────────────────────────────────────────────
// Fast-load policy (display-only snapshot, stale-while-revalidate)
//
// The headline USDsui figure is a live gRPC read (~600-1800ms) with no
// decision consumer (sends are validated by the chain at build/broadcast,
// not by this number). So we serve a Postgres snapshot instantly when it's
// reasonably fresh and refresh from chain in the background; the live read
// only blocks the response when the snapshot is missing or quite stale, or
// when the caller asks for `?fresh=1` (iOS pull-to-refresh + the optimistic
// post-send reconcile, which MUST always see the chain).
const SNAPSHOT_SERVE_MAX_MS = 120_000; // serve a snapshot at most this old
const SNAPSHOT_BG_REFRESH_MS = 15_000; // ...and warm it in bg if older than this
const PRICE_DB_TTL_MS = 45_000; // SUI/USDC global price freshness

type BalancesPayload = {
  address: string;
  usdsui: number;
  sui: number;
  suiPriceUsd: number;
  totalUsd: number;
};

/**
 * SUI/USDC spot, a GLOBAL value (same for every user). Prefer the shared
 * Postgres row so cold instances never pay the 800-2000ms DeepBook quote;
 * fall back to the (capped) live quote only when the row is missing, and
 * warm the row in the background when it's stale.
 */
async function resolveSuiPrice(): Promise<number> {
  const g = await getGlobalNum("sui_usdc_price").catch(() => null);
  if (g && g.value > 0) {
    if (Date.now() - g.refreshedAt > PRICE_DB_TTL_MS) {
      refreshInBackground(async () => {
        const fresh = await cachedSuiUsdcPrice().catch(() => 0);
        if (fresh > 0) await setGlobalNum("sui_usdc_price", fresh);
      });
    }
    return g.value;
  }
  // No usable row yet, pay the capped live quote once, then persist.
  const live = await withTimeout(cachedSuiUsdcPrice(), 600, 0);
  if (live > 0) refreshInBackground(async () => setGlobalNum("sui_usdc_price", live));
  return live;
}

/**
 * Headline USDsui read with two integrity rules (2026-06-11 incident: a
 * transient gRPC failure was swallowed to 0, snapshotted as source="chain",
 * and displayed as ₦0 to a user holding $22.84):
 *
 *   1. FAILURE THROWS. A failed read must never be mistaken for "the chain
 *      says zero", the caller skips the snapshot write-through and serves
 *      the freshest prior snapshot instead.
 *   2. ZERO-CONFIRMATION. If the read says 0 but the previous snapshot was
 *      meaningfully nonzero, re-verify against a DIRECT fullnode before
 *      believing it (the primary read rides Hayabusa, a caching proxy -
 *      a stale cached zero must not zero out a funded account).
 */
async function readHeadlineUsdsui(
  address: string,
  prevUsdsui: number | null
): Promise<{ usdsui: number; raw: string }> {
  const read = await getUsdsuiBalanceStrict(address);
  if (read.usdsui !== 0 || !prevUsdsui || prevUsdsui <= 0.01) return read;
  const direct = await suiGrpcBroadcast((c) =>
    c.getBalance({ owner: address, coinType: USDSUI_TYPE })
  );
  const raw = direct.balance.balance;
  const confirmed = Number(BigInt(raw)) / Math.pow(10, USDSUI_DECIMALS);
  if (confirmed !== 0) {
    console.warn(
      `[balances] zero-confirmation MISMATCH for ${address.slice(0, 10)}…: primary read said 0, direct fullnode says ${confirmed}`
    );
  }
  return { usdsui: confirmed, raw };
}

/**
 * The live wallet+vault balance read (the slow path). Folds the vault and
 * resolves the global price, then write-throughs the snapshot so the next
 * load is instant. THROWS when the headline USDsui read fails (secondary
 * slots, SUI, price, vault, still soft-fail to 0).
 */
async function computeLiveBalances(user: {
  id: number;
  sui_address: string;
  talise_vault_id: string | null;
  prevUsdsui?: number | null;
}): Promise<BalancesPayload> {
  const usdsuiPromise = readHeadlineUsdsui(
    user.sui_address,
    user.prevUsdsui ?? null
  );
  const suiPromise = withTimeout(
    getSuiBalance(user.sui_address).catch(() => ({ sui: 0, mist: "0" })),
    600,
    { sui: 0, mist: "0" }
  );
  const pricePromise = resolveSuiPrice();

  const vaultId = user.talise_vault_id ?? null;
  const vaultPromise: Promise<VaultTotals> = vaultId
    ? withTimeout(
        readVaultTotals(vaultId).catch((err: unknown) => {
          console.warn(
            `[balances] vault fold-in failed for ${vaultId}: ${
              (err as Error)?.message ?? String(err)
            }`
          );
          return { usdsui: 0, sui: 0 };
        }),
        800,
        { usdsui: 0, sui: 0 }
      )
    : Promise.resolve({ usdsui: 0, sui: 0 });

  const usdsui = await usdsuiPromise;
  const [sui, suiPrice, vault] = await Promise.all([
    suiPromise,
    pricePromise,
    vaultPromise,
  ]);

  const combinedUsdsui = usdsui.usdsui + vault.usdsui;
  const combinedSui = sui.sui + vault.sui;
  const totalUsd = combinedUsdsui + combinedSui * (suiPrice || 0);

  const payload: BalancesPayload = {
    address: user.sui_address,
    usdsui: combinedUsdsui,
    sui: combinedSui,
    suiPriceUsd: suiPrice,
    totalUsd,
  };

  // Write-through: this read becomes the snapshot for the next load.
  await writeBalanceSnapshot({
    userId: user.id,
    suiAddress: user.sui_address,
    usdsui: combinedUsdsui,
    sui: combinedSui,
    suiPriceUsd: suiPrice,
    totalUsd,
    source: "chain",
  });

  return payload;
}

export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const fresh = new URL(req.url).searchParams.get("fresh") === "1";

  // One snapshot read serves every path below: the snapshot-first response,
  // the zero-confirmation reference (prevUsdsui), and the timeout fallback.
  const snap = await readBalanceSnapshot(userId).catch(() => null);

  // Snapshot-first: serve a reasonably-fresh last-known value instantly and
  // refresh from chain in the background. Skip entirely on ?fresh=1.
  if (!fresh) {
    if (snap && Date.now() - snap.refreshedAt <= SNAPSHOT_SERVE_MAX_MS) {
      const ageMs = Date.now() - snap.refreshedAt;
      if (ageMs > SNAPSHOT_BG_REFRESH_MS) {
        refreshInBackground(async () => {
          await computeLiveBalances({
            id: user.id,
            sui_address: user.sui_address,
            talise_vault_id: user.talise_vault_id ?? null,
            prevUsdsui: snap.usdsui,
          });
        });
      }
      return NextResponse.json(
        {
          address: snap.suiAddress || user.sui_address,
          usdsui: snap.usdsui,
          sui: snap.sui,
          suiPriceUsd: snap.suiPriceUsd,
          totalUsd: snap.totalUsd,
          refreshedAt: snap.refreshedAt,
          stale: ageMs > SNAPSHOT_BG_REFRESH_MS,
          source: "snapshot",
        },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }
  }

  // No usable snapshot (or ?fresh=1): BOUNDED live chain read. The headline
  // balance is display-only (sends are validated on-chain at build/broadcast,
  // not by this number), so we never let a slow/unhealthy RPC make the user
  // wait, cap the live read and fall back to the freshest snapshot. The live
  // promise keeps running and write-throughs the snapshot, so it self-heals.
  // A FAILED live read (rejection) also falls back to the snapshot, a stale
  // honest number always beats a fabricated $0.
  const LIVE_BUDGET_MS = 4500;
  const livePromise = computeLiveBalances({
    id: user.id,
    sui_address: user.sui_address,
    talise_vault_id: user.talise_vault_id ?? null,
    prevUsdsui: snap?.usdsui ?? null,
  });
  const liveGuarded = livePromise.catch((err) => {
    console.warn(
      `[balances] live read failed user=${userId}: ${(err as Error)?.message ?? err}`
    );
    return null;
  });
  const live = await withTimeout(liveGuarded, LIVE_BUDGET_MS, null);
  if (live) {
    return NextResponse.json(
      { ...live, refreshedAt: Date.now(), stale: false, source: "chain" },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  }
  // Live read blew the budget or failed, serve the freshest snapshot we have
  // (ANY age beats a 40s spinner or a fake zero). A still-in-flight live read
  // will write the snapshot through when it lands.
  if (snap) {
    return NextResponse.json(
      {
        address: snap.suiAddress || user.sui_address,
        usdsui: snap.usdsui,
        sui: snap.sui,
        suiPriceUsd: snap.suiPriceUsd,
        totalUsd: snap.totalUsd,
        refreshedAt: snap.refreshedAt,
        stale: true,
        source: "snapshot-timeout",
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  }
  // Brand-new user with no snapshot at all, wait for the live read. If even
  // that fails, return zeros explicitly marked source="chain-error" (NOT
  // snapshotted) so the client can treat it as unknown rather than gospel.
  const payload = await liveGuarded;
  if (payload) {
    return NextResponse.json(
      { ...payload, refreshedAt: Date.now(), stale: false, source: "chain" },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  }
  return NextResponse.json(
    {
      address: user.sui_address,
      usdsui: 0,
      sui: 0,
      suiPriceUsd: 0,
      totalUsd: 0,
      refreshedAt: Date.now(),
      stale: true,
      source: "chain-error",
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}
