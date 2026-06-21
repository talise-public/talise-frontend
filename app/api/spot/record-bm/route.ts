import { NextResponse } from "next/server";
import { readSessionEntryId } from "@/lib/session";
import { setSpotBalanceManagerId, userById } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const userId = await readSessionEntryId();
  if (!userId)
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const user = await userById(userId);
  if (!user)
    return NextResponse.json({ error: "user not found" }, { status: 404 });

  let body: { bmId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const bmId = (body.bmId ?? "").trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(bmId)) {
    return NextResponse.json({ error: "bad bm id" }, { status: 400 });
  }
  await setSpotBalanceManagerId(user.id, bmId);
  return NextResponse.json({ ok: true });
}
