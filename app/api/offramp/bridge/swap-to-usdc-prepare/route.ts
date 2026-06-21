import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import { usdWithdrawalAllowed, USD_WITHDRAWAL_CLOSED_MESSAGE } from "@/lib/offramp-access";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { AggregatorClient } from "@cetusprotocol/aggregator-sdk";
import { sui, network, COIN_TYPES, USDSUI_DECIMALS } from "@/lib/sui";
import { USDSUI_TYPE } from "@/lib/usdsui";
import { TREASURY_WALLET } from "@/lib/navi-supply";
import { onara } from "@/lib/onara";
import { memoTtl } from "@/lib/perf-cache";

export const runtime = "nodejs";

/**
 * POST /api/offramp/bridge/swap-to-usdc-prepare
 *
 * Step 1 of the decoupled cash-out: swap `amountUsdsui` USDsui → USDC and
 * deliver the USDC to the USER'S OWN wallet (their "USDC pocket"), taking the
 * 1% Talise fee to the treasury during the swap (Cetus overlay). This is a
 * plain swap — NOT a swap-and-send — so the off-ramp send is a separate, simple
 * USDC transfer (see send-usdc-prepare). iOS signs the returned bytes with
 * signAndExecuteRaw.
 *
 * Body: { amountUsdsui: number }
 * Response: { bytes, mode: "sponsored-swap-to-usdc", amountUsdsui, estimatedUsdcMicros }
 */

const SLIPPAGE_BPS = 100; // 1.00%
const SWAP_FEE_BPS = 100; // 1.00% Talise fee → treasury (Cetus overlay)

export async function POST(req: Request) {
  const onaraUrl = process.env.ONARA_URL;
  if (!onaraUrl) {
    return NextResponse.json({ error: "ONARA_URL not configured" }, { status: 503 });
  }
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const rl = await rateLimitAsync({ key: `swap-to-usdc:user:${userId}`, limit: 30, windowSec: 3600 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }
  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });
  // USD withdrawal is gated to an allowlist during pilot (rolandojude18 only).
  if (!usdWithdrawalAllowed(user)) {
    return NextResponse.json(
      { error: USD_WITHDRAWAL_CLOSED_MESSAGE, code: "USD_WITHDRAWAL_CLOSED" },
      { status: 403 }
    );
  }

  let body: { amountUsdsui?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const amountUsdsui =
    typeof body.amountUsdsui === "number" && Number.isFinite(body.amountUsdsui)
      ? body.amountUsdsui
      : 0;
  if (amountUsdsui <= 0) {
    return NextResponse.json({ error: "amountUsdsui must be > 0" }, { status: 400 });
  }
  const fromMicros = BigInt(Math.round(amountUsdsui * 10 ** USDSUI_DECIMALS));

  try {
    const onaraClient = onara();
    const client = sui();
    const net = network();
    const sponsorPromise = memoTtl(`onara:status:${onaraUrl}`, 60_000, () => onaraClient.status());
    const gasPricePromise = memoTtl(`sui:gas-price:${net}`, 1_500, async () => {
      const r = await client.getReferenceGasPrice();
      return r.referenceGasPrice;
    });

    const tx = new Transaction();
    tx.setSender(user.sui_address);

    const aggregator = new AggregatorClient({
      client,
      signer: user.sui_address,
      overlayFeeRate: SWAP_FEE_BPS / 10_000, // 1.00% → treasury
      overlayFeeReceiver: TREASURY_WALLET,
    });
    const cetusRouter = await aggregator.findRouters({
      from: USDSUI_TYPE,
      target: COIN_TYPES.USDC,
      amount: fromMicros.toString(),
      byAmountIn: true,
    });
    if (!cetusRouter || cetusRouter.insufficientLiquidity) {
      return NextResponse.json(
        { error: "No swap route available right now. Try again shortly.", code: "NO_ROUTE_SWAP" },
        { status: 503 }
      );
    }
    const estimatedUsdcMicros = BigInt(cetusRouter.amountOut.toString());

    const inputCoin = tx.add(
      coinWithBalance({ type: USDSUI_TYPE, balance: fromMicros, useGasCoin: false })
    );
    const outCoin = await aggregator.routerSwap({
      router: cetusRouter,
      inputCoin,
      slippage: SLIPPAGE_BPS / 10_000,
      txb: tx,
    });
    // Keep the swapped USDC in the user's own wallet — the "USDC pocket".
    tx.transferObjects([outCoin], user.sui_address);

    const [{ address: sponsor }, gasPrice] = await Promise.all([sponsorPromise, gasPricePromise]);
    tx.setGasOwner(sponsor);
    tx.setGasPrice(BigInt(gasPrice));
    const bytes = await tx.build({ client: client as never });

    console.log(
      `[offramp/swap-to-usdc] user=${userId} from=${fromMicros} estUsdc=${estimatedUsdcMicros} sponsor=${sponsor}`
    );
    return NextResponse.json({
      bytes: toBase64(bytes),
      mode: "sponsored-swap-to-usdc",
      amountUsdsui,
      estimatedUsdcMicros: estimatedUsdcMicros.toString(),
    });
  } catch (err) {
    console.warn(`[offramp/swap-to-usdc] user=${userId} failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: "Couldn't set up the swap. Please try again.", code: "SWAP_PREPARE_FAILED" },
      { status: 500 }
    );
  }
}
