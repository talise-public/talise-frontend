import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { USDSUI_TYPE } from "@/lib/usdsui";
import { filterVerified } from "@/lib/coins-verified";

export const runtime = "nodejs";

/**
 * GET /api/wallet/balances — flat enumeration of every coin balance in
 * the authed user's PLAIN wallet (not the vault). Used by the "Convert
 * all to USDsui" sweep CTA to discover what's eligible to swap.
 *
 * The headline `/api/balances` endpoint only ships USDsui + SUI totals
 * for the home screen; that's not enough to drive a multi-leg sweep
 * (the user might be holding WAL or USDC). Going around the SDK with a
 * direct `suix_getAllBalances` call mirrors the cron path in
 * `app/api/cron/auto-swap-sweep` which proved that the SDK's
 * `getAllBalances` returns empty for some addresses despite raw RPC
 * working — so we use the same belt-and-braces.
 *
 * Returns:
 *   { address, balances: [{ coinType, amount: u64-as-string, isUsdsui: bool }] }
 *
 * Zero balances are filtered. USDsui is included with a flag so the
 * caller can decide whether to skip it client-side (the sweep should
 * skip USDsui → USDsui, but the home tile may want to show it).
 */
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

  const nonZero = rows.filter((r) => r.coinType && BigInt(r.totalBalance ?? "0") > 0n);
  // ALWAYS IGNORE NON-VERIFIED coins: only Cetus-verified coins (USDsui +
  // convertible blue-chips) are surfaced. Spam/airdrop tokens (no liquidity)
  // never appear → never offered in "Convert all" → no failed swap, no error.
  const verified = await filterVerified(nonZero);
  const balances = verified.map((r) => ({
    coinType: r.coinType,
    amount: r.totalBalance,
    isUsdsui: r.coinType === USDSUI_TYPE,
  }));

  return NextResponse.json({
    address: user.sui_address,
    balances,
  });
}
