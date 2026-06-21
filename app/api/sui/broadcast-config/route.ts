import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { shinamiSuiNodeJsonRpc } from "@/lib/shinami";

/**
 * GET /api/sui/broadcast-config
 *
 * Returns the Sui JSON-RPC endpoint iOS should use for the
 * direct-broadcast (gasless) rail. When `SHINAMI_NODE_API_KEY` is set we
 * route iOS through Shinami's paid Sui node; otherwise we fall back to
 * the free public mainnet fullnode.
 *
 * SHAPE:
 *   {
 *     url: string,                       // e.g. "https://api.us1.shinami.com/sui/node/v1"
 *     headers: Record<string, string>,   // e.g. { "X-Api-Key": "<KEY>" } — empty {} for public
 *     provider: "shinami" | "public"     // for iOS telemetry / dashboards
 *   }
 *
 * SECURITY NOTE: when `provider === "shinami"` this endpoint ships the
 * Shinami node key (`X-Api-Key`) directly to the iOS client.
 *
 *   - The Shinami **node** key is a metered-RPC credential — it has
 *     no signing capability, can't initiate sponsored transactions,
 *     and can't read or move user funds. The blast radius of a
 *     leaked node key is "someone uses our quota" (rate-limited
 *     reads + a paid-tier bill we already cap at our chosen plan).
 *
 *   - The Shinami **gas-station** / **wallet** keys are a different
 *     story — they can sponsor transactions and resolve zkLogin
 *     wallets. Those MUST stay server-side (see `lib/shinami.ts` —
 *     `apiKey()` reads them and never exposes them through any
 *     route).
 *
 *   - Plan (tracked in TODO-APPATTEST.md sibling): rotate to a
 *     dedicated low-rate-limit Shinami node key before flipping
 *     `directBroadcastEnabled` default-on for all users. Until
 *     then this endpoint stays gated by the same auth check the
 *     rest of the gasless path uses (mobile bearer / session).
 *
 * CACHING: `Cache-Control: private, max-age=900` (15 min). iOS will
 * cache this aggressively — every send round-tripping for the URL
 * would add ~80ms per call, which defeats the point of paying for a
 * faster RPC. 15 min is long enough to amortize the cost and short
 * enough that a key rotation propagates within a working session.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUBLIC_MAINNET_URL = "https://fullnode.mainnet.sui.io:443";

export async function GET(req: Request) {
  // Auth gate mirrors `/api/send/sponsor-prepare`: any caller that can
  // hit the prepare endpoint can hit this one. Both have the same
  // threat model (the Shinami node key is exposed by /broadcast-config
  // but the prepare endpoint runs the actual gasless build that would
  // call Shinami server-side either way — there is no escalation here
  // beyond what an already-authenticated client could already do).
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const shinami = shinamiSuiNodeJsonRpc();
  const body = shinami
    ? {
        url: shinami.url,
        headers: shinami.headers,
        provider: "shinami" as const,
      }
    : {
        url: PUBLIC_MAINNET_URL,
        headers: {} as Record<string, string>,
        provider: "public" as const,
      };

  return NextResponse.json(body, {
    headers: {
      "Cache-Control": "private, max-age=900",
    },
  });
}
