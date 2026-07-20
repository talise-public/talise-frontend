import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { filterVerified } from "@/lib/coins-verified";

export const runtime = "nodejs";

/**
 * POST /api/wallet/sweep
 *
 * "Convert all to USDsui", bulk swap of plain-wallet (NOT vault) coins
 * into USDsui via the Cetus aggregator. The PTB is built by Onara's
 * `/wallet-sweep` route (which carries the aggregator SDK + gRPC
 * client); this proxy just authenticates the caller, attaches the
 * owner address from the user row, and forwards the response so the
 * iOS app can sign + sponsor-execute in the standard zkLogin path.
 *
 * Body:
 *   { coins: [{ coinType: string, amount: string (u64 raw) }] }
 *
 * Returns: { bytesB64, sender }, same shape as the vault PTB endpoints,
 * intended to be fed into `ZkLoginCoordinator.signAndSubmit`.
 */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: { coins?: Array<{ coinType?: string; amount?: string | number }> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const coins = Array.isArray(body.coins) ? body.coins : [];
  if (coins.length === 0) {
    return NextResponse.json({ error: "coins[] required" }, { status: 400 });
  }

  // Normalize amount → u64 string so Onara's zod regex accepts it
  // regardless of whether iOS sent a number or a string.
  const normalized = coins.map((c) => ({
    coinType: (c.coinType ?? "").trim(),
    amount:
      typeof c.amount === "number"
        ? Math.trunc(c.amount).toString()
        : (c.amount ?? "").toString().trim(),
  }));

  // SERVER-SIDE GUARD: never sweep a NON-VERIFIED coin. A stale client (or a
  // spam token like LMAGMA_COIN) would otherwise hit the Cetus aggregator,
  // fail with "insufficient liquidity", and leak a raw error into activity.
  const swept = await filterVerified(normalized);
  if (swept.length === 0) {
    return NextResponse.json(
      { error: "no verified coins to convert", code: "NO_VERIFIED_COINS" },
      { status: 400 }
    );
  }

  const onaraUrl = process.env.ONARA_URL;
  if (!onaraUrl) {
    return NextResponse.json(
      { error: "ONARA_URL not configured" },
      { status: 503 }
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${onaraUrl}/wallet-sweep`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        owner: user.sui_address,
        coins: swept,
      }),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "onara unreachable: " + (err as Error).message },
      { status: 502 }
    );
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    // Forward Onara's error verbatim so callers see "no route for X"
    // etc. without an opaque 500.
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  }

  let parsed: {
    ok?: boolean;
    bytesB64?: string;
    sender?: string;
    error?: string;
    estUsdsuiOut?: string;
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: "onara returned non-JSON" },
      { status: 502 }
    );
  }
  if (!parsed.ok || !parsed.bytesB64 || !parsed.sender) {
    return NextResponse.json(
      { error: parsed.error ?? "onara wallet-sweep failed" },
      { status: 502 }
    );
  }

  return NextResponse.json({
    bytesB64: parsed.bytesB64,
    sender: parsed.sender,
    // Forwarded estimate (raw u64 USDsui, 6-dp) so iOS can credit the 1
    // pt/$1 swap reward. USDsui is 1:1 USD → USD = estUsdsuiOut / 1e6.
    estUsdsuiOut: parsed.estUsdsuiOut,
  });
}
