import { NextResponse } from "next/server";
import {
  readSendLatencySamples,
  type SendLatencyLeg,
  type SendLatencySample,
} from "@/lib/perf-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health/send-latency
 *
 * Operator-facing endpoint that returns the last N timing samples from
 * the in-process ring buffer fed by `/api/send/sponsor-prepare` and
 * `/api/zk/sponsor-execute` (see `recordSendLatency` in
 * `lib/perf-cache.ts`).
 *
 * Useful for live verification of the latency win without grepping
 * Vercel logs:
 *
 *   curl https://app.talise.com/api/health/send-latency | jq
 *
 * The buffer is per-process so distinct Vercel function instances
 * report distinct samples; refresh a few times to get a representative
 * picture. Bounded to 64 entries (see `SEND_LATENCY_MAX`), so this is
 * intentionally lossy, it's a freshness signal, not an analytics
 * pipeline.
 *
 * No auth needed. The values are aggregate timing numbers (no PII, no
 * addresses, no digests).
 */
export async function GET(req: Request) {
  const samples = readSendLatencySamples();
  const stats = summarise(samples);
  // Optional `?legacy=1` to return just the array (kept simple in case
  // someone wires this into an existing dashboard later).
  const url = new URL(req.url);
  if (url.searchParams.get("legacy") === "1") {
    return NextResponse.json({ samples });
  }
  return NextResponse.json({
    count: samples.length,
    capacity: 64,
    summary: stats,
    samples,
  });
}

type LegSummary = {
  n: number;
  p50: number | null;
  p95: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
};

/**
 * Per-leg p50/p95/avg/min/max from the in-process samples. Cheap
 * enough to compute on every GET (the buffer caps at 64 entries).
 */
function summarise(samples: SendLatencySample[]): Record<SendLatencyLeg, LegSummary> {
  const buckets: Record<SendLatencyLeg, number[]> = {
    prepare: [],
    execute: [],
  };
  for (const s of samples) {
    buckets[s.leg].push(s.totalMs);
  }
  const out = {} as Record<SendLatencyLeg, LegSummary>;
  (Object.keys(buckets) as SendLatencyLeg[]).forEach((leg) => {
    out[leg] = summariseLeg(buckets[leg]);
  });
  return out;
}

function summariseLeg(values: number[]): LegSummary {
  if (values.length === 0) {
    return { n: 0, p50: null, p95: null, avg: null, min: null, max: null };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const pick = (q: number) => {
    if (sorted.length === 0) return null;
    const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return sorted[idx];
  };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    p50: pick(0.5),
    p95: pick(0.95),
    avg: Math.round(sum / sorted.length),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}
