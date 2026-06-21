import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { USDSUI_TYPE } from "@/lib/usdsui";
import { filterVerified } from "@/lib/coins-verified";
import { cetusUniverse, normCoinType } from "@/lib/cetus-tokens";
import { getSuiUsdcPrice } from "@/lib/deepbook";
import { memoTtl } from "@/lib/perf-cache";

export const runtime = "nodejs";

/**
 * GET /api/wallet/balances — every coin in the authed user's PLAIN wallet,
 * enriched for the Token Bucket UI.
 *
 * "Verified" = the coin has a liquid Cetus pool (coins-verified.ts, which now
 * pulls the live Cetus universe), so real holdings like WAL/DEEP/BUCK show and
 * are swappable while no-liquidity spam never appears. Each coin is enriched
 * with on-chain metadata (symbol, decimals, logo via suix_getCoinMetadata) and
 * a USD value where the price is reliable (stablecoins 1:1, SUI via DeepBook).
 *
 * Returns: { address, balances: [{ coinType, amount, isUsdsui, symbol,
 *            decimals, logoUrl, usdValue }] }. `usdValue` is null when there is
 * no trustworthy price (the amount + symbol still render).
 */

type CoinMeta = { symbol: string; decimals: number; logoUrl: string | null };

async function coinMetadata(rpcUrl: string, coinType: string): Promise<CoinMeta> {
  return memoTtl(`coinmeta:${coinType}`, 24 * 60 * 60 * 1000, async () => {
    try {
      const r = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "suix_getCoinMetadata",
          params: [coinType],
        }),
        signal: AbortSignal.timeout(6000),
      });
      const j = (await r.json()) as {
        result?: { symbol?: string; decimals?: number; iconUrl?: string | null };
      };
      const m = j.result;
      if (m) {
        return {
          symbol: m.symbol ?? "",
          decimals: typeof m.decimals === "number" ? m.decimals : 9,
          logoUrl: m.iconUrl ?? null,
        };
      }
    } catch {
      /* fall through to default */
    }
    return { symbol: "", decimals: 9, logoUrl: null };
  });
}

/** Best-effort ticker from the type tag's final `::Name` segment. */
function shortSymbol(coinType: string): string {
  const last = coinType.split("::").pop();
  return last && last.length ? last.toUpperCase() : coinType.slice(0, 6);
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

  const rpcUrl =
    process.env.SUI_RPC_URL || "https://fullnode.mainnet.sui.io:443";

  let rows: Array<{ coinType: string; totalBalance: string }>;
  try {
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "suix_getAllBalances",
        params: [user.sui_address],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      return NextResponse.json(
        { error: `suix_getAllBalances HTTP ${r.status}` },
        { status: 502 }
      );
    }
    const body = (await r.json()) as {
      result?: Array<{ coinType: string; totalBalance: string }>;
      error?: { message: string };
    };
    if (body.error) {
      return NextResponse.json({ error: body.error.message }, { status: 502 });
    }
    rows = body.result ?? [];
  } catch (err) {
    return NextResponse.json(
      { error: "rpc failure: " + (err as Error).message },
      { status: 502 }
    );
  }

  const nonZero = rows.filter(
    (r) => r.coinType && BigInt(r.totalBalance ?? "0") > 0n
  );
  // Only coins with a liquid Cetus pool (or the hardcoded floor) survive, so
  // spam never appears and everything shown is actually swappable.
  const verified = await filterVerified(nonZero);

  // Price inputs (best-effort, never block the response).
  let suiPrice = 0;
  try {
    suiPrice = await getSuiUsdcPrice();
  } catch {
    /* leave 0 → SUI value omitted */
  }
  const cetus = await cetusUniverse();

  const balances = await Promise.all(
    verified.map(async (r) => {
      const meta = await coinMetadata(rpcUrl, r.coinType);
      const symbol =
        meta.symbol ||
        cetus.symbol.get(normCoinType(r.coinType)) ||
        shortSymbol(r.coinType);
      const decimals = meta.decimals;
      const human = Number(BigInt(r.totalBalance)) / Math.pow(10, decimals);
      const isUsdsui = r.coinType === USDSUI_TYPE;
      const low = r.coinType.toLowerCase();

      // USD value only where the price is trustworthy: stablecoins are 1:1,
      // SUI uses the DeepBook spot. Everything else stays null (the amount and
      // symbol still render; the real USD is shown at swap time).
      let usdValue: number | null = null;
      if (isUsdsui || low.includes("::usdc::")) {
        usdValue = human;
      } else if (low.includes("::sui::sui")) {
        usdValue = suiPrice > 0 ? human * suiPrice : null;
      }

      return {
        coinType: r.coinType,
        amount: r.totalBalance,
        isUsdsui,
        symbol,
        decimals,
        logoUrl: meta.logoUrl,
        usdValue,
      };
    })
  );

  return NextResponse.json({
    address: user.sui_address,
    balances,
  });
}
