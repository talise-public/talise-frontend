import { NextResponse } from "next/server";
import { readSessionEntryId } from "@/lib/session";
import { userById } from "@/lib/db";
import { assembleZkLoginSignature } from "@/lib/zksigner";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const userId = await readSessionEntryId();
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: {
    txBytesB64?: string;
    ephemeralPubKeyB64?: string;
    maxEpoch?: number;
    randomness?: string;
    userSignature?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  if (
    !body.txBytesB64 ||
    !body.ephemeralPubKeyB64 ||
    !body.userSignature ||
    !body.randomness ||
    typeof body.maxEpoch !== "number"
  ) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }

  try {
    const zkLoginSignature = await assembleZkLoginSignature({
      ephemeralPubKeyB64: body.ephemeralPubKeyB64,
      maxEpoch: body.maxEpoch,
      randomness: body.randomness,
      userSignature: body.userSignature,
    });
    return NextResponse.json({ zkLoginSignature });
  } catch (err) {
    const msg = (err as Error).message ?? "sign failed";
    const status = msg.includes("No active sign-in") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
