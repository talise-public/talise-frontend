/**
 * WaterX prediction markets (Sui mainnet), binary YES/NO markets that settle
 * in the SAME CREDIT (minted 1:1 from USDsui) and use the SAME waterx_account as
 * perps. So the account / deposit / withdraw rails in lib/waterx.ts apply
 * unchanged; this module adds the market reads + bet / claim builders.
 *
 * Gated behind FEATURE_PERPS (same flag).
 */
import type { Transaction } from "@mysten/sui/transactions";
import {
  PredictClient,
  getUnresolvedMarkets,
  getAccountPositionIdsByMarketId,
  getPosition,
  buildPlaceOrderTx,
  buildBatchClaimTx,
} from "@waterx/sdk/prediction";
import { perp } from "./waterx";

const CONFIG_URL =
  process.env.WATERX_CONFIG_URL ??
  "https://raw.githubusercontent.com/WaterXProtocol/waterx-config/main/mainnet.json";
const SHARE_SCALE = 1e6; // settlement CREDIT is 6-dp; shares/cost share that scale

let _pc: Promise<PredictClient> | null = null;
export function predict(): Promise<PredictClient> {
  if (!_pc) {
    const grpcUrl = process.env.SUI_GRPC_URL ?? "https://fullnode.mainnet.sui.io:443";
    _pc = PredictClient.mainnet({ grpcUrl, waterxConfigUrl: CONFIG_URL }).catch((e) => {
      _pc = null;
      throw e;
    });
  }
  return _pc;
}

export type PredictMarket = {
  key: string;
  marketId: string;
  title?: string; // human-readable question (from metadata, if available)
  imageUrl?: string;
  yesPct: number; // implied probability (normalized)
  noPct: number;
  yesPrice: number; // $ per YES share (0..1)
  noPrice: number;
  volumeUsd: number;
  resolved: boolean;
  outcome: string | null;
};

/**
 * Optional off-chain metadata (question text + image) keyed by marketId hex.
 * WaterX keeps this off-chain; set WATERX_PREDICT_META_URL to a JSON map
 * `{ "0x…": { "title": "...", "imageUrl": "..." } }` and titles/icons light up.
 */
type MarketMeta = Record<string, { title?: string; imageUrl?: string }>;
let _metaCache: { at: number; data: MarketMeta } | null = null;
async function marketMeta(): Promise<MarketMeta> {
  const url = process.env.WATERX_PREDICT_META_URL;
  if (!url) return {};
  if (_metaCache && Date.now() - _metaCache.at < 60_000) return _metaCache.data;
  try {
    const r = await fetch(url, { cache: "no-store" });
    const data = (await r.json()) as MarketMeta;
    _metaCache = { at: Date.now(), data };
    return data;
  } catch {
    return _metaCache?.data ?? {};
  }
}

/** Live (unpaused) YES/NO markets with implied odds + volume. */
export async function listPredictionMarkets(): Promise<PredictMarket[]> {
  const c = await predict();
  const [ms, meta] = await Promise.all([getUnresolvedMarkets(c), marketMeta()]);
  return ms
    .filter((m) => !m.paused)
    .map((m) => {
      const md = meta[m.marketIdHex] ?? meta[String(m.marketKey)] ?? {};
      const ys = Number(m.yesShares), yc = Number(m.yesCost);
      const ns = Number(m.noShares), nc = Number(m.noCost);
      const yesPrice = ys > 0 ? yc / ys : 0.5;
      const noPrice = ns > 0 ? nc / ns : 0.5;
      const sum = yesPrice + noPrice || 1;
      const yesPct = Math.round((yesPrice / sum) * 100);
      return {
        key: String(m.marketKey),
        marketId: m.marketIdHex,
        title: md.title,
        imageUrl: md.imageUrl,
        yesPrice,
        noPrice,
        yesPct,
        noPct: 100 - yesPct,
        volumeUsd: (yc + nc) / SHARE_SCALE,
        resolved: m.resolved,
        outcome: m.outcome,
      };
    })
    .sort((a, b) => b.volumeUsd - a.volumeUsd);
}

export type PredictPosition = {
  positionId: string;
  marketId: string;
  marketKey: string;
  selection: string;
  shares: number;
  cost: number;
  payout: number;
  resolved: boolean;
  outcome: string | null;
  won: boolean;
};

/** The account's positions across live markets (best-effort, capped). */
export async function listPredictionPositions(objectAccountId: string): Promise<PredictPosition[]> {
  const c = await predict();
  // The prediction account id IS the waterx_account object id (verified via
  // getAccountIds), no separate registry-id resolution needed.
  const accountId = objectAccountId;
  const markets = (await getUnresolvedMarkets(c)).slice(0, 24);
  const out: PredictPosition[] = [];
  await Promise.all(
    markets.map(async (m) => {
      try {
        const ids = await getAccountPositionIdsByMarketId(c, { accountId, marketId: m.marketIdHex });
        for (const pid of ids) {
          const p = await getPosition(c, { positionId: pid });
          out.push({
            positionId: String(p.positionId),
            marketId: m.marketIdHex,
            marketKey: String(m.marketKey),
            selection: p.selection,
            shares: Number(p.filledShares) / SHARE_SCALE,
            cost: Number(p.filledCost) / SHARE_SCALE,
            payout: Number(p.payout) / SHARE_SCALE,
            resolved: m.resolved,
            outcome: m.outcome,
            won: m.resolved ? m.outcome === p.selection : false,
          });
        }
      } catch {
        /* market with no positions / read error */
      }
    }),
  );
  return out;
}

/** Buy YES or NO shares. Sweeps the user's USDsui → CREDIT and places the order. */
export async function buildBetTx(
  objectAccountId: string,
  marketId: string,
  selection: "YES" | "NO",
  betUsd: number,
  price: number,
): Promise<Transaction> {
  const c = await predict();
  const pc = await perp();
  const accountId = objectAccountId; // == waterx_account object id (see above)
  const maxSpend = BigInt(Math.round(betUsd * SHARE_SCALE));
  const priceCapBps = Math.min(9900, Math.max(100, Math.round(price * 10_000) + 500)); // +5% slippage
  const minShares = (maxSpend * 10_000n) / BigInt(priceCapBps);
  const expiryTs = Date.now() + 5 * 60 * 1000;
  return buildPlaceOrderTx(pc, c, {
    accountId,
    marketId,
    selection,
    maxSpend,
    minShares,
    priceCapBps,
    expiryTs,
    consolidateToUsd: true,
  });
}

/** Claim winnings from resolved positions. */
export async function buildClaimTx(objectAccountId: string, positionIds: string[]): Promise<Transaction> {
  const c = await predict();
  const pc = await perp();
  return buildBatchClaimTx(pc, c, {
    accountId: objectAccountId,
    positionIds: positionIds.map((id) => BigInt(id)),
  });
}
