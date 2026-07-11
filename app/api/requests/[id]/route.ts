import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { getRequest, previewRequest, cancelRequest } from "@/lib/requests";

export const runtime = "nodejs";

/**
 * GET /api/requests/[id] — PUBLIC preview (no auth). Returns a public-safe
 * subset: amount, currency, the requester's display + pay address, an optional
 * note, status, and expiry. Powers the public /req/<id> page's client refresh.
 *
 * When the caller IS the owner, the full request row is returned instead so the
 * owner's UI can render the audit fields (pay digest, payer address).
 *
 * DELETE /api/requests/[id] — owner-only cancel of an open request.
 */

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const viewerId = await readEntryIdFromRequest(req);
  if (viewerId != null) {
    const owned = await getRequest(id);
    if (owned && owned.userId === viewerId) {
      return NextResponse.json({ request: owned, owner: true });
    }
  }

  const preview = await previewRequest(id);
  if (!preview) {
    return NextResponse.json({ error: "request not found" }, { status: 404 });
  }
  return NextResponse.json({ request: preview, owner: false });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const rl = await rateLimitAsync({
    key: `requests-mutate:user:${userId}`,
    limit: 120,
    windowSec: 3600,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }

  const { id } = await params;
  const request = await getRequest(id);
  if (!request) {
    return NextResponse.json({ error: "request not found" }, { status: 404 });
  }
  if (request.userId !== userId) {
    return NextResponse.json(
      { error: "only the requester can cancel this request" },
      { status: 403 }
    );
  }
  if (request.status === "paid") {
    return NextResponse.json(
      { error: "A paid request can't be cancelled." },
      { status: 409 }
    );
  }

  const cancelled = await cancelRequest(id, userId);
  if (!cancelled) {
    return NextResponse.json(
      { error: `This request is already ${request.status}.` },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true, status: "cancelled" });
}
