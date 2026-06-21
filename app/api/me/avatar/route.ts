import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { setUserPfp } from "@/lib/db";

export const runtime = "nodejs";

/**
 * POST /api/me/avatar
 *   { imageUrl: "https://…" }  → set the avatar override (e.g. an NFT image)
 *   { clear: true }            → clear it (fall back to the Google picture)
 *
 * Additive + idempotent. Only https URLs are accepted (an NFT picker resolves
 * ipfs:// to a gateway before sending). Does not touch any other profile state.
 */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  let body: { imageUrl?: string; clear?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  if (body.clear) {
    await setUserPfp(userId, null);
    return NextResponse.json({ ok: true, pfpUrl: null });
  }

  const url = String(body.imageUrl ?? "").trim();
  if (!/^https:\/\/.+/i.test(url) || url.length > 2048) {
    return NextResponse.json({ error: "imageUrl must be an https URL" }, { status: 400 });
  }
  await setUserPfp(userId, url);
  return NextResponse.json({ ok: true, pfpUrl: url });
}
