import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userByReferralCode } from "@/lib/db";
import { normalizeReferralCode } from "@/lib/auth-exchange";
import { emitGrowthEvent } from "@/lib/referral-events";
import { rateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * POST /api/referral/event { name, code, surface? } → { ok }
 *
 * Client-side half of the referral funnel. The server can only see the events
 * it participates in (`invite_clicked` on /r/<CODE>, `invite_signup` at
 * attribution); the two ends of the loop happen entirely on a device:
 *
 *   • `invite_sent`    , the share sheet was accepted or the link copied. This
 *     is the DENOMINATOR of K-factor. Nothing recorded it before, so
 *     "invites per user" was unknowable and K could not be computed at all.
 *   • `invite_clicked` , an invite deep link opened the APP directly. Once
 *     /r/* is claimed by Universal Links / App Links the browser never hits
 *     the web handler, so without this the click count would silently drop to
 *     zero for exactly the users who have the app.
 *
 * Trust model. This endpoint only writes telemetry, never money or points, but
 * it still must not be a free metrics-pollution channel:
 *   • `invite_sent` requires authentication and is always attributed to the
 *     CALLER, so it cannot inflate someone else's invite count.
 *   • `invite_clicked` is allowed unauthenticated (the clicker is by definition
 *     not signed in yet) but the code must resolve to a real inviter, so it
 *     cannot manufacture events for codes that do not exist.
 *   • Both are rate limited per IP.
 */

const ALLOWED = new Set(["invite_sent", "invite_clicked"] as const);
type Allowed = "invite_sent" | "invite_clicked";

export async function POST(req: Request) {
  const rl = rateLimit({
    key: `referral-event:${getClientIp(req)}`,
    limit: 30,
    windowSec: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } }
    );
  }

  let body: { name?: string; code?: string; surface?: string; channel?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const name = String(body.name ?? "");
  if (!ALLOWED.has(name as Allowed)) {
    return NextResponse.json({ ok: false, error: "unknown event" }, { status: 400 });
  }
  const code = normalizeReferralCode(body.code);
  if (!code) {
    return NextResponse.json({ ok: false, error: "invalid code" }, { status: 400 });
  }
  // Free-form but bounded, these land in a metadata blob.
  const surface = (body.surface ?? "").slice(0, 16) || "unknown";
  const channel = (body.channel ?? "").slice(0, 24) || null;

  const userId = await readEntryIdFromRequest(req);

  if (name === "invite_sent") {
    if (!userId) {
      return NextResponse.json(
        { ok: false, error: "not authenticated" },
        { status: 401 }
      );
    }
    await emitGrowthEvent("invite_sent", { userId, code, surface, channel });
    return NextResponse.json({ ok: true });
  }

  // invite_clicked: must name a real inviter.
  const inviter = await userByReferralCode(code);
  if (!inviter) {
    return NextResponse.json({ ok: false, error: "invalid code" }, { status: 400 });
  }
  await emitGrowthEvent("invite_clicked", {
    code,
    surface,
    inviterId: inviter.id,
    // Present when an already-signed-in user taps someone's invite, useful for
    // separating genuine new-user clicks from noise.
    userId: userId ?? null,
  });
  return NextResponse.json({ ok: true });
}
