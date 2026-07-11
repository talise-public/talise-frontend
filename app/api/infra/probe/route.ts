import { NextResponse } from "next/server";
import { resolveAdminFromRequest } from "@/lib/admin-auth";
import { runProbe, allProbeIds, type ProbeResult } from "@/lib/infra-probes";
import type { ProbeId } from "@/lib/infra-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/infra/probe[?check=<probeId>]
 *
 * Times one integration probe (read-only) and returns its latency. With no
 * `check`, runs them all in parallel. Admin-gated (same posture as /admin):
 * this hits real upstreams, so it's not public.
 */
export async function GET(req: Request) {
  if (!(await resolveAdminFromRequest(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const check = new URL(req.url).searchParams.get("check") as ProbeId | null;
  if (check) {
    return NextResponse.json(await runProbe(check));
  }
  const results: ProbeResult[] = await Promise.all(allProbeIds().map(runProbe));
  return NextResponse.json({ results });
}
