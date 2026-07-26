import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { registerDeviceToken } from "@/lib/db";
import { trackPushEnabled } from "@/lib/analytics/emit";

export const runtime = "nodejs";

/**
 * POST /api/devices/register, register this device's push token for the
 * authed user. iOS calls this from the AppDelegate's
 * `didRegisterForRemoteNotificationsWithDeviceToken` (with the session bearer
 * attached). The token is upserted (UNIQUE), so re-registration is idempotent.
 *
 * Body: { token: string, platform?: "ios" | "android" }
 */
export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  let body: { token?: string; platform?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const token = (body.token ?? "").trim();
  // APNs hex tokens are 64 chars today but Apple reserves the right to grow
  // them; accept a generous bound and reject anything implausible.
  if (!token || token.length < 32 || token.length > 256) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }
  const platform = body.platform === "android" ? "android" : "ios";

  try {
    await registerDeviceToken(userId, token, platform);
    // GROWTH: a registered token is SERVER-SIDE PROOF the OS permission prompt
    // was granted — the OS only hands the app a token after the user accepts. So
    // this stamps `push_enabled_at` from a fact rather than from a client claim,
    // and it is what makes push reachability + notification CTR measurable. The
    // token itself is never passed to analytics (it is a device identifier).
    trackPushEnabled(userId, platform);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.warn(
      `[devices/register] failed user=${userId}: ${(e as Error).message}`
    );
    return NextResponse.json({ error: "register failed" }, { status: 500 });
  }
}
