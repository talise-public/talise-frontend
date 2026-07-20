import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { agentWalletsEnabled, revokeAgentWallet } from "@/lib/agent-wallets";

export const runtime = "nodejs";

/** POST /api/agent/wallet/revoke, revoke one of the caller's agent wallets. Body: { id }. */
export async function POST(req: Request) {
  if (!agentWalletsEnabled()) {
    return NextResponse.json({ error: "Agent wallets are not enabled.", code: "AGENT_WALLETS_OFF" }, { status: 503 });
  }
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  let body: { id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const revoked = await revokeAgentWallet(userId, id);
  if (!revoked) return NextResponse.json({ error: "wallet not found or already revoked" }, { status: 404 });
  return NextResponse.json({ ok: true, id });
}
