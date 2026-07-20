import { NextResponse } from "next/server";
import {
  shieldConfigured,
  shieldRelayerAddress,
  shieldMaxRelayerFee,
} from "@/lib/shield/relayer-config";
import { SHIELD_RPC } from "@/lib/shield/onchain";
import { USDSUI_TYPE } from "@/lib/usdsui";
import { memoTtl } from "@/lib/perf-cache";

export const runtime = "nodejs";

/**
 * The relayer's largest USDsui coin object id, the withdraw leg splits a ZERO
 * coin off it via the allowlisted SplitCoins glue (`coin::zero` isn't on the
 * relayer command allowlist). The split is non-destructive (a 0-amount split
 * leaves the source whole), and coin object ids are public on-chain, so this is
 * safe to expose. Memoized 30s, the coin is stable. Returns null if none yet.
 */
async function relayerZeroCoinSource(relayer: string): Promise<string | null> {
  return memoTtl(`shield:relayer-zero-coin:${relayer}`, 30_000, async () => {
    try {
      const res = await fetch(SHIELD_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "suix_getCoins",
          params: [relayer, USDSUI_TYPE],
        }),
      });
      const j = (await res.json()) as {
        result?: { data?: { coinObjectId: string; balance: string }[] };
      };
      const coins = j.result?.data ?? [];
      if (!coins.length) return null;
      // Largest balance, most headroom, least likely to be mid-flight.
      coins.sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));
      return coins[0].coinObjectId;
    } catch {
      return null;
    }
  });
}

/**
 * GET /api/shield/relayer
 *
 * Returns the relayer's Sui address so the client SDK can set
 * `ExtData.relayer` (and the fee recipient) to a value the relayer will
 * actually accept. The client builds the proof + ext_data with THIS address;
 * `/api/shield/relay` then re-asserts it matches before sponsoring.
 *
 * 503 when the shielded-pool relayer is not configured (no `SHIELD_PKG` /
 * `SHIELD_RELAYER_ADDRESS`), the whole Workstream-C surface is dormant by
 * default.
 */
export async function GET() {
  if (!shieldConfigured()) {
    return NextResponse.json(
      { error: "shield relayer not configured" },
      { status: 503 }
    );
  }
  const address = shieldRelayerAddress();
  const zeroCoinSourceId = address ? await relayerZeroCoinSource(address) : null;
  return NextResponse.json({
    address,
    maxRelayerFee: shieldMaxRelayerFee().toString(),
    ...(zeroCoinSourceId ? { zeroCoinSourceId } : {}),
  });
}
