import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { YIELD_ROUTER } from "@/lib/yield/onchain";

const MAINNET_RPC =
  process.env.SUI_FULLNODE_URL ?? "https://fullnode.mainnet.sui.io";

export const runtime = "nodejs";

/**
 * GET /api/yield/position
 *
 * Returns the caller's `talise_yield::YieldPosition` object id (or null if they
 * haven't minted one yet), by scanning `PositionMinted` events for one whose
 * `owner` matches the user's address. The position is a SHARED object, so it
 * can't be found via getOwnedObjects, the mint event is the index.
 *
 * Used by the Earn "test deposit" flow to decide mint-vs-deposit.
 */
export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const user = await userById(userId);
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  try {
    const norm = (a: string) => a.toLowerCase().replace(/^0x0*/, "0x");
    const want = norm(user.sui_address);
    const rpc = await fetch(MAINNET_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "suix_queryEvents",
        params: [
          { MoveEventType: `${YIELD_ROUTER.packageId}::yield_router::PositionMinted` },
          null,
          50,
          true, // descending
        ],
      }),
    });
    const body = (await rpc.json()) as {
      result?: { data?: Array<{ parsedJson?: { position_id?: string; owner?: string } }> };
    };
    const mine = (body.result?.data ?? []).find(
      (e) => e.parsedJson?.owner && norm(e.parsedJson.owner) === want
    );
    return NextResponse.json({ positionId: mine?.parsedJson?.position_id ?? null });
  } catch (err) {
    return NextResponse.json({ positionId: null, error: (err as Error).message });
  }
}
