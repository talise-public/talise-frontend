import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { updateUserProfile, userById } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId)
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const user = await userById(userId);
  if (!user)
    return NextResponse.json({ error: "user not found" }, { status: 404 });

  let body: {
    name?: string;
    businessName?: string;
    businessIndustry?: string;
    country?: string;
    notifyOnReceive?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // Each user-supplied string capped at a sane DB-friendly length.
  // Without these caps a hostile (or buggy) client can persist
  // arbitrary kilobytes into the users row on every settings POST.
  const clip = (v: string | undefined, max: number): string | null => {
    const t = (v ?? "").trim();
    if (!t) return null;
    return t.length > max ? t.slice(0, max) : t;
  };

  await updateUserProfile(userId, {
    name: clip(body.name, 64),
    businessName: clip(body.businessName, 64),
    businessIndustry: clip(body.businessIndustry, 48),
    country: clip(body.country, 8),
    notifyOnReceive: body.notifyOnReceive,
  });

  return NextResponse.json({ ok: true });
}
