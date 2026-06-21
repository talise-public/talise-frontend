import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { issueAttestChallenge } from "@/lib/app-attest";

export const runtime = "nodejs";

/**
 * Issue a single-use, server-persisted challenge for App Attest key
 * registration. The iOS app generates a key in the Secure Enclave,
 * hashes this challenge, and passes both back to
 * `/api/auth/attest/register`.
 *
 * The challenge is persisted server-side with a 5-minute TTL and
 * consumed atomically on register. Replay attempts fail at the DB
 * layer; expired or unknown nonces fail the same way.
 */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const challenge = await issueAttestChallenge(userId);
  return NextResponse.json({ challenge });
}
