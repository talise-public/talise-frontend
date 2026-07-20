import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { getRoundupConfig, setRoundupConfig } from "@/lib/rewards/roundup";

export const runtime = "nodejs";

/**
 * GET  /api/rewards/roundup
 *   → { enabled: boolean, percentage: number, savedUsd: number }
 *
 * POST /api/rewards/roundup
 *   body: { enabled?: boolean, percentage?: number }
 *   → same shape, post-update
 *
 * Owns the user-facing config for Phase 2 Round-up & Save. The actual
 * roundup booking happens in /api/zk/sponsor-execute after a send
 * settles, this route is purely the toggle + slider backend for the
 * iOS RoundupCard.
 */

export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  try {
    const cfg = await getRoundupConfig(userId);
    return NextResponse.json(cfg);
  } catch (err) {
    console.warn(
      `[rewards/roundup GET] user=${userId} failed: ${(err as Error).message}`
    );
    return NextResponse.json(
      { error: "could not read roundup config" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  let body: { enabled?: unknown; percentage?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // Validate the inputs, only accept the two documented fields, and
  // clip percentage to 1..10 (server-side; setRoundupConfig also
  // clamps, but rejecting bad shapes here gives the client a clearer
  // error.)
  const patch: { enabled?: boolean; percentage?: number } = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled must be boolean" },
        { status: 400 }
      );
    }
    patch.enabled = body.enabled;
  }
  if (body.percentage !== undefined) {
    const p = Number(body.percentage);
    if (!Number.isFinite(p) || p < 1 || p > 10) {
      return NextResponse.json(
        { error: "percentage must be 1..10" },
        { status: 400 }
      );
    }
    patch.percentage = Math.round(p);
  }

  try {
    const cfg = await setRoundupConfig({ userId, ...patch });
    // Bust the per-user 60s memo in sponsor-prepare so the next send
    // sees the new enabled/percentage without waiting for the TTL to
    // expire. Otherwise toggling SnS off and immediately sending hits
    // the cached enabled=true and falls into the sponsored path even
    // though the user is now eligible for the faster gasless rail.
    const { invalidate } = await import("@/lib/perf-cache");
    invalidate(`roundup:cfg:${userId}`);
    return NextResponse.json(cfg);
  } catch (err) {
    console.warn(
      `[rewards/roundup POST] user=${userId} failed: ${(err as Error).message}`
    );
    return NextResponse.json(
      { error: "could not update roundup config" },
      { status: 500 }
    );
  }
}
