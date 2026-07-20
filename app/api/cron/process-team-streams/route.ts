import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-auth";
import { teamStreamsEnabled, releaseDueTeamStreams } from "@/lib/team-streams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Team-stream release engine. Runs on a Vercel cron; releases every due tranche
 * across all active team streams, each tranche pays an equal share to every
 * member via gasless escrow sends. Idempotent: a tranche is claimed atomically
 * before payout, so a double-fire can't double-pay.
 *
 * Auth: Vercel injects `Authorization: Bearer $CRON_SECRET` on scheduled runs.
 */
export async function GET(req: Request) {
  const denied = requireCron(req);
  if (denied) return denied;

  if (!teamStreamsEnabled()) {
    return NextResponse.json({ ok: true, skipped: "team streaming disabled" });
  }

  try {
    const summary = await releaseDueTeamStreams();
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.warn(`[cron/process-team-streams] failed: ${(err as Error).message}`);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
