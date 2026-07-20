import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { userById } from "@/lib/db";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { sui, USDSUI_DECIMALS } from "@/lib/sui";
import { USDSUI_TYPE } from "@/lib/usdsui";
import {
  buildSupplyUsdsuiMargin,
  fetchSupplierCapId,
} from "@/lib/deepbook-margin";
import { appendNaviSupply, SAVE_TREASURY_FEE_BPS, TREASURY_WALLET } from "@/lib/navi-supply";
import { buildScallopSupply, SCALLOP_SUPPLY_ENABLED } from "@/lib/yield/ptb";
import { getYieldComparison } from "@/lib/yield";
import { appendPaymentKitReceipt } from "@/lib/intents/wrap-payment-kit";

export const runtime = "nodejs";

/**
 * POST /api/earn/supply/build
 *
 * Constructs a sponsored-ready PTB that supplies USDsui to the chosen
 * yield venue. Today only the DeepBook margin pool is wired (Talise's
 * highest-APY USDsui venue); NAVI follows the same pattern and will be
 * added when we port the @t2000 SDK PTB builder.
 *
 * Body: { venue: "deepbook" | "navi", amount: number }
 * Returns: { transactionKindB64 }, feed straight into /api/zk/sponsor.
 */

// "best" auto-routes to the highest live APY among the wired USDsui venues
// (NAVI account-based + Scallop sUSDsui), the SAM-style "earn at the best
// rate" toggle. DeepBook stays selectable but is excluded from the best
// auto-pick (its USDsui margin APY is ~0).
// Scallop is gated by SCALLOP_SUPPLY_ENABLED, its supply currently reverts on
// a stale version object, so while disabled it's neither selectable nor a
// "best" candidate, and deposits route to NAVI (live).
const SUPPORTED_VENUES = new Set(
  ["deepbook", "navi", "best", ...(SCALLOP_SUPPLY_ENABLED ? ["scallop"] : [])]
);
const BEST_CANDIDATES = new Set(
  ["navi", ...(SCALLOP_SUPPLY_ENABLED ? ["scallop"] : [])]
);

export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: { venue?: string; amount?: number | string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  let venue = (body.venue ?? "best").toLowerCase();
  if (!SUPPORTED_VENUES.has(venue)) {
    return NextResponse.json(
      { error: `venue must be one of ${[...SUPPORTED_VENUES].join(", ")}` },
      { status: 400 }
    );
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { error: "amount must be a positive number" },
      { status: 400 }
    );
  }

  // "best" → auto-route to the highest live APY among the wired venues. This
  // is the SAM-style toggle: the engine picks the best rate at deposit time.
  if (venue === "best") {
    const cmp = await getYieldComparison(user.sui_address).catch(() => null);
    const top = cmp?.venues
      .filter((v) => BEST_CANDIDATES.has(v.id))
      .sort((a, b) => b.apy - a.apy)[0];
    venue = top?.id ?? "navi"; // fall back to NAVI if the comparison is unavailable
  }

  try {
    const t0 = Date.now();
    const tx = new Transaction();
    tx.setSender(user.sui_address);

    if (venue === "navi") {
      // NAVI is the real default, live ~5% APY on USDsui supply.
      // @t2000/sdk 2.11's NaviAdapter.addSaveToTx is now public, so
      // we can build the supply PTB inline without going through the
      // web-only /api/t2000/execute route.
      // Saving into yield is a "Save", skim the 1% treasury fee like the
      // spend-and-save round-up legs do, then supply the remainder.
      await appendNaviSupply(tx, user.sui_address, amount, {
        treasuryFeeBps: SAVE_TREASURY_FEE_BPS,
      });
    } else if (venue === "scallop") {
      // Scallop USDsui market, mint sUSDsui (interest-bearing receipt coin)
      // straight to the user. Direct supply (no yield_router position), the
      // sCoin accrues via exchange rate and the user can redeem any time.
      const onchain = BigInt(Math.round(amount * 10 ** USDSUI_DECIMALS));
      const usdsui = coinWithBalance({ type: USDSUI_TYPE, balance: onchain, useGasCoin: false })(tx);
      // 1% treasury fee on the saved amount (same as the round-up legs).
      const feeOnchain = (onchain * BigInt(SAVE_TREASURY_FEE_BPS)) / 10_000n;
      if (feeOnchain > 0n) {
        const [fee] = tx.splitCoins(usdsui, [tx.pure.u64(feeOnchain)]);
        tx.transferObjects([fee], tx.pure.address(TREASURY_WALLET));
      }
      const sUsdsui = buildScallopSupply(tx, usdsui);
      tx.transferObjects([sUsdsui], tx.pure.address(user.sui_address));
    } else {
      // DeepBook margin pool, USDsui borrow demand is ~0% so the
      // realized APY is also ~0%. We still expose the venue for the
      // user who wants to provide liquidity to bootstrap utilization,
      // but it's no longer the default.
      const capId = await fetchSupplierCapId(user.sui_address).catch(() => null);
      buildSupplyUsdsuiMargin({
        senderAddress: user.sui_address,
        amountUsdsui: amount,
        existingSupplierCapId: capId,
      }).build(tx);
    }

    // Universal Talise receipt, appends a Payment Kit
    // `processRegistryPayment` 1-micro self-ping carrying a typed
    // memo `talise/v1|invest|...|venue=navi|...`. The venue's own
    // MoveCalls above do the real money movement; this just tags
    // the tx so the activity classifier (and any third-party
    // indexer) can recover the kind + venue authoritatively from
    // the on-chain PaymentRecord instead of sniffing MoveCall
    // packages heuristically.
    const { nonce } = appendPaymentKitReceipt(tx, {
      kind: "invest",
      sender: user.sui_address,
      refs: { venue },
    });

    const tAppend = Date.now();
    const kind = await tx.build({
      client: sui() as never,
      onlyTransactionKind: true,
    });

    // Verification log, per the 2026-05-29 sponsorship-matrix directive.
    // Prepare returns transactionKindB64; the gasOwner + gasPrice get set
    // in /api/zk/sponsor (which logs the full `mode=sponsored sponsor=<addr>
    // gasPrice=<n>` shape). Emitting `mode=sponsored` here lets us greppably
    // confirm the prepare→sponsor handoff for the earn supply leg.
    // append/build timings split the venue SDK's RPC chain from coin
    // resolution, the data needed to tell a slow venue from a slow node
    // (a 21s dev prepare turned out to be Lagos→us-east amplification of
    // the SDK's serial reads).
    console.log(
      `[earn/supply/prepare] mode=sponsored venue=${venue} amount=${amount} ` +
        `append=${tAppend - t0}ms build=${Date.now() - tAppend}ms`
    );

    return NextResponse.json({
      transactionKindB64: toBase64(kind),
      venue,
      amount,
      receiptNonce: nonce,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "build failed: " + (err as Error).message },
      { status: 500 }
    );
  }
}
