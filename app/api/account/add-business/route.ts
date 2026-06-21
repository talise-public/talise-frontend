import { NextResponse } from "next/server";
import { readSessionEntryId } from "@/lib/session";
import {
  addBusinessProfile,
  hasBusiness,
  isHandleTaken,
  userById,
} from "@/lib/db";

export const runtime = "nodejs";

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export async function POST(req: Request) {
  const userId = await readSessionEntryId();
  if (!userId)
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const user = await userById(userId);
  if (!user)
    return NextResponse.json({ error: "user not found" }, { status: 404 });

  if (hasBusiness(user)) {
    return NextResponse.json(
      { error: "business already set up" },
      { status: 409 }
    );
  }

  let body: {
    businessName?: string;
    businessHandle?: string;
    businessIndustry?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const name = (body.businessName ?? "").trim();
  const handle = (body.businessHandle ?? "").trim().toLowerCase();
  if (name.length < 2)
    return NextResponse.json({ error: "business name too short" }, { status: 400 });
  if (!HANDLE_RE.test(handle))
    return NextResponse.json(
      { error: "handle must be 2-32 chars of a-z, 0-9, hyphen" },
      { status: 400 }
    );
  if (await isHandleTaken(handle))
    return NextResponse.json({ error: "handle is taken" }, { status: 409 });

  await addBusinessProfile(user.id, {
    businessName: name,
    businessHandle: handle,
    businessIndustry: body.businessIndustry?.trim() || null,
  });

  return NextResponse.json({ ok: true, redirect: "/business/dashboard" });
}
