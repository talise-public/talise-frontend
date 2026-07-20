import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import { usdWithdrawalAllowed, USD_WITHDRAWAL_CLOSED_MESSAGE } from "@/lib/offramp-access";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { sui, network, COIN_TYPES } from "@/lib/sui";
import { onara } from "@/lib/onara";
import { memoTtl } from "@/lib/perf-cache";
import { bridgeConfigured } from "@/lib/bridge/client";
import { getOnrampKyc } from "@/lib/onramp/kyc-store";
import { findExistingCashout } from "@/lib/bridge/offramp";
import { appendPaymentKitReceipt } from "@/lib/intents/wrap-payment-kit";
import type { BridgeFiatCurrency } from "@/lib/bridge/onramp";

export const runtime = "nodejs";

/**
 * POST /api/offramp/bridge/send-usdc-prepare
 *
 * Step 2 of the decoupled cash-out: a PLAIN USDC transfer from the user's USDC
 * pocket to their Bridge cash-out address (resolved server-side, never sent by
 * the client). No swap, no fee leg, just `transferObjects(usdc, bridgeAddr)`,
 * Onara-sponsored. Bridge then wires USD to the user's bank. This is the simple
 * send the founder asked for in place of the combined swap-and-send PTB.
 *
 * Bridge won't pay out below $1.00, so amounts under that are rejected.
 *
 * Body: { amountUsdc: number, currency?: "usd" }
 * Response: { bytes, mode: "sponsored-usdc-send", amountUsdc, destinationPaymentRail }
 */

const USDC_DECIMALS = 6;
const BRIDGE_MIN_USDC_MICROS = 1_000_000n; // $1.00

export async function POST(req: Request) {
  const onaraUrl = process.env.ONARA_URL;
  if (!onaraUrl) {
    return NextResponse.json({ error: "ONARA_URL not configured" }, { status: 503 });
  }
  if (!bridgeConfigured()) {
    return NextResponse.json({ error: "bridge_offramp_disabled" }, { status: 503 });
  }
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const rl = await rateLimitAsync({ key: `send-usdc:user:${userId}`, limit: 30, windowSec: 3600 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });
  // USD withdrawal is gated to an allowlist during pilot (rolandojude18 only).
  if (!usdWithdrawalAllowed(user)) {
    return NextResponse.json(
      { error: USD_WITHDRAWAL_CLOSED_MESSAGE, code: "USD_WITHDRAWAL_CLOSED" },
      { status: 403 }
    );
  }

  let body: { amountUsdc?: number; currency?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const amountUsdc =
    typeof body.amountUsdc === "number" && Number.isFinite(body.amountUsdc) ? body.amountUsdc : 0;
  const amountMicros = BigInt(Math.round(amountUsdc * 10 ** USDC_DECIMALS));
  if (amountMicros < BRIDGE_MIN_USDC_MICROS) {
    return NextResponse.json(
      { error: "Bridge's minimum payout is $1.00. Send at least $1.00 in USDC.", code: "BELOW_BRIDGE_MIN" },
      { status: 400 }
    );
  }
  const currency = (body.currency ?? "usd").toLowerCase() as BridgeFiatCurrency;
  const wantRail = currency === "eur" ? "sepa" : "wire";

  const kyc = await getOnrampKyc(userId);
  const customerId = kyc?.providerCustomerId;
  if (!customerId) {
    return NextResponse.json(
      { error: "complete identity verification first", code: "NO_BRIDGE_CUSTOMER" },
      { status: 409 }
    );
  }
  const route = await findExistingCashout(customerId, currency, wantRail);
  if (!route) {
    return NextResponse.json(
      { error: "no cash-out route set up for this currency", code: "NO_ROUTE" },
      { status: 409 }
    );
  }

  const client = sui();
  // Pre-check the USDC pocket so an empty/short pocket returns a clean message
  // instead of a coin-resolution 500 at build time.
  try {
    const bal = await client.getBalance({
      owner: user.sui_address,
      coinType: COIN_TYPES.USDC,
    });
    // gRPC shape: { balance: { balance: "<raw u64>" } }, not `totalBalance`.
    const have = BigInt((bal as { balance?: { balance?: string } }).balance?.balance ?? "0");
    if (have < amountMicros) {
      return NextResponse.json(
        {
          error: "Not enough USDC in your pocket. Swap USDsui → USDC first.",
          code: "INSUFFICIENT_USDC",
        },
        { status: 400 }
      );
    }
  } catch {
    /* balance read failed, fall through and let the build surface it */
  }

  try {
    const onaraClient = onara();
    const net = network();
    const sponsorPromise = memoTtl(`onara:status:${onaraUrl}`, 60_000, () => onaraClient.status());
    const gasPricePromise = memoTtl(`sui:gas-price:${net}`, 1_500, async () => {
      const r = await client.getReferenceGasPrice();
      return r.referenceGasPrice;
    });

    const tx = new Transaction();
    tx.setSender(user.sui_address);
    // Plain USDC transfer out of the user's pocket → Bridge cash-out address.
    const usdc = tx.add(
      coinWithBalance({ type: COIN_TYPES.USDC, balance: amountMicros, useGasCoin: false })
    );
    tx.transferObjects([usdc], route.address);

    // Onara's sponsorship policy requires an allowlisted MoveCall in the PTB; a
    // bare native transfer has none and gets rejected at execute. The standard
    // Talise receipt (`processRegistryPayment`, a non-transfer "withdraw" kind =
    // 1-micro self-ping marker, NOT money to a third party) supplies that
    // MoveCall and tags the tx, same primitive every other sponsored flow uses.
    appendPaymentKitReceipt(tx, {
      kind: "withdraw",
      sender: user.sui_address,
      refs: { venue: "bridge" },
    });

    const [{ address: sponsor }, gasPrice] = await Promise.all([sponsorPromise, gasPricePromise]);
    tx.setGasOwner(sponsor);
    tx.setGasPrice(BigInt(gasPrice));
    const bytes = await tx.build({ client: client as never });

    console.log(
      `[offramp/send-usdc] user=${userId} amount=${amountMicros} → ${route.address} rail=${route.rail} sponsor=${sponsor}`
    );
    return NextResponse.json({
      bytes: toBase64(bytes),
      mode: "sponsored-usdc-send",
      amountUsdc,
      destinationPaymentRail: route.rail,
    });
  } catch (err) {
    console.warn(`[offramp/send-usdc] user=${userId} failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: "Couldn't set up the transfer. Please try again.", code: "SEND_USDC_FAILED" },
      { status: 500 }
    );
  }
}
