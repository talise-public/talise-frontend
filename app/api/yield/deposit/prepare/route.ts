import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { sui, USDSUI_DECIMALS } from "@/lib/sui";
import { USDSUI_TYPE } from "@/lib/usdsui";
import { YIELD_ROUTER, yieldRouterTarget } from "@/lib/yield/onchain";
import { buildScallopSupply, SCALLOP_SUSDSUI_TYPE, VENUE_ID } from "@/lib/yield/ptb";

export const runtime = "nodejs";

/**
 * POST /api/yield/deposit/prepare
 *
 * Sponsored-ready PTB for the live `talise_yield::yield_router` (mainnet
 * pkg in lib/yield/onchain.ts). Two modes:
 *
 *   • no `positionId`  → `mint_position` only (one-time; creates the user's
 *     shared YieldPosition). Client reads the new object id from effects,
 *     then calls again with it.
 *   • with `positionId` → supply USDsui into the venue + `deposit_receipt`
 *     the venue receipt into the position (honest cost-basis tracked).
 *
 * Scallop is the first wired venue: cleanest receipt model (a transferable
 * sUSDsui coin), and its supply signature is devInspect-verified on mainnet.
 * NAVI/Suilend/AlphaLend follow (AccountCap / cToken / PositionCap receipts).
 *
 * Body: { venue?: "scallop", amount?: number, positionId?: string }
 * Returns: { transactionKindB64, mode }, feed into /api/zk/sponsor.
 */

const SUPPORTED = new Set(["scallop"]); // expanding as each venue is verified

export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  let body: { venue?: string; amount?: number | string; positionId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const tx = new Transaction();
  tx.setSender(user.sui_address);

  // ── Mode 1: mint the position (no deposit) ──
  if (!body.positionId) {
    tx.moveCall({ target: yieldRouterTarget("mint_position") });
    const kind = await tx.build({ client: sui() as never, onlyTransactionKind: true });
    return NextResponse.json({ transactionKindB64: toBase64(kind), mode: "mint" });
  }

  // ── Mode 2: supply + deposit_receipt into the existing position ──
  const venue = (body.venue ?? "scallop").toLowerCase();
  if (!SUPPORTED.has(venue)) {
    return NextResponse.json(
      { error: `venue must be one of ${[...SUPPORTED].join(", ")} (more venues wiring in)` },
      { status: 400 }
    );
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
  }
  const onchain = BigInt(Math.round(amount * 10 ** USDSUI_DECIMALS));

  try {
    // Source exactly `amount` USDsui from the user's coins (merge+split as needed).
    const usdsui = coinWithBalance({ type: USDSUI_TYPE, balance: onchain, useGasCoin: false })(tx);
    // Supply → sUSDsui receipt coin.
    const sUsdsui = buildScallopSupply(tx, usdsui);
    // Custody the receipt under the position; track cost basis (onchain units).
    tx.moveCall({
      target: yieldRouterTarget("deposit_receipt"),
      typeArguments: [SCALLOP_SUSDSUI_TYPE],
      arguments: [
        tx.object(body.positionId),
        sUsdsui,
        tx.pure.u8(VENUE_ID.scallop),
        tx.pure.u64(onchain),
      ],
    });

    const kind = await tx.build({ client: sui() as never, onlyTransactionKind: true });
    console.log(
      `[yield/deposit/prepare] mode=sponsored venue=${venue} amount=${amount} ` +
        `position=${body.positionId.slice(0, 10)} pkg=${YIELD_ROUTER.packageId.slice(0, 10)}`
    );
    return NextResponse.json({ transactionKindB64: toBase64(kind), mode: "deposit", venue, amount });
  } catch (err) {
    return NextResponse.json({ error: "build failed: " + (err as Error).message }, { status: 500 });
  }
}
