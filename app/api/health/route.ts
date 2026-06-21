import { NextResponse } from "next/server";
import { dbHealth } from "@/lib/db";
import { sui } from "@/lib/sui";
import { onara } from "@/lib/onara";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * Single endpoint that pings every external dependency Talise relies on
 * and reports per-leg status + latency. Used by:
 *
 *   - Railway / Vercel platform health probes (top-level `ok` field).
 *   - Smoke testing after deploys (curl + grep "ok\":true").
 *   - Debugging which upstream is degraded during incidents.
 *
 * Legs:
 *   - db        — libSQL connection + schema check
 *   - sui       — Sui RPC reachability (getReferenceGasPrice)
 *   - onara     — Onara sponsor gateway (/status)
 *
 * All legs run in parallel so the worst-case latency is the slowest leg.
 */
export async function GET() {
  const t0 = Date.now();

  const [dbLeg, suiLeg, onaraLeg] = await Promise.all([
    dbHealth(),
    suiCheck(),
    onaraCheck(),
  ]);

  const ok = dbLeg.ok && suiLeg.ok && onaraLeg.ok;
  const body = {
    ok,
    totalMs: Date.now() - t0,
    timestamp: new Date().toISOString(),
    version: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? "dev",
    network: process.env.NEXT_PUBLIC_SUI_NETWORK ?? "mainnet",
    legs: {
      db: dbLeg,
      sui: suiLeg,
      onara: onaraLeg,
    },
  };

  return NextResponse.json(body, { status: ok ? 200 : 503 });
}

async function suiCheck() {
  const t0 = Date.now();
  try {
    await sui().getReferenceGasPrice();
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: (err as Error).message,
    };
  }
}

async function onaraCheck() {
  const t0 = Date.now();
  if (!process.env.ONARA_URL) {
    return { ok: false, latencyMs: 0, error: "ONARA_URL not configured" };
  }
  try {
    const { address } = await onara().status();
    return { ok: !!address, latencyMs: Date.now() - t0, address };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: (err as Error).message,
    };
  }
}
