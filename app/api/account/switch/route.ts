import { NextResponse } from "next/server";
import { readSessionEntryId } from "@/lib/session";
import { hasBusiness, switchActiveContext, userById } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const userId = await readSessionEntryId();
  if (!userId)
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const user = await userById(userId);
  if (!user)
    return NextResponse.json({ error: "user not found" }, { status: 404 });

  let body: { to?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const to = body.to === "business" ? "business" : "personal";
  if (to === "business" && !hasBusiness(user)) {
    return NextResponse.json(
      { error: "business profile not set up" },
      { status: 409 }
    );
  }

  await switchActiveContext(user.id, to);
  return NextResponse.json({
    ok: true,
    redirect: to === "business" ? "/business/dashboard" : "/app",
  });
}
