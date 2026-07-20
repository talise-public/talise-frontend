import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { agentWalletsEnabled, listAgentWallets } from "@/lib/agent-wallets";

export const runtime = "nodejs";

/** GET /api/agent/wallet/list, the caller's custodial agent wallets. */
export async function GET(req: Request) {
  if (!agentWalletsEnabled()) return NextResponse.json({ wallets: [] });
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const wallets = await listAgentWallets(userId);
  return NextResponse.json({ wallets });
}
