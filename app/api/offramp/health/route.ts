import { NextResponse } from "next/server";

import { requireCron } from "@/lib/cron-auth";
import { cashoutOpen, corridorProviderOrder, stubsAllowed } from "@/lib/offramp/config";
import { resolvePayoutCorridor, allProviders } from "@/lib/offramp/registry";
import { listProviderHealth, listRefundsOwed, resetProviderHealth } from "@/lib/offramp/store";
import type { PayoutCurrency } from "@/lib/offramp/types";

export const runtime = "nodejs";

/**
 * GET /api/offramp/health , the operator view of the fiat-out rails.
 *
 * Answers, for every corridor, the question an incident starts with: "is this
 * corridor up, which provider is serving it, and if it's degraded, WHY?" That
 * used to require reading logs and guessing from a 502.
 *
 * Auth: `requireCron` (fails closed). This exposes provider names, config
 * readiness reasons and refund counts, so it is not public.
 *
 * POST ?reset=<providerId> force-closes a provider's circuit after a fix,
 * instead of waiting out the cooldown.
 */

const CORRIDORS: PayoutCurrency[] = [
  "NGN",
  "USD",
  "EUR",
  "KES",
  "GHS",
  "ZAR",
  "JPY",
  "SGD",
];

export async function GET(req: Request) {
  const unauthorized = requireCron(req);
  if (unauthorized) return unauthorized;

  const corridors = await Promise.all(
    CORRIDORS.map(async (ccy) => {
      const res = await resolvePayoutCorridor(ccy);
      return {
        currency: ccy,
        configuredOrder: corridorProviderOrder(ccy),
        selected: res.selected?.id ?? null,
        degraded: res.degraded,
        candidates: res.candidates.map((c) => ({
          provider: c.id,
          rank: c.rank,
          usable: c.usable,
          reason: c.reason ?? null,
          breakerState: c.breaker?.state ?? null,
          retryAtMs: c.breaker?.retryAtMs ?? null,
        })),
      };
    })
  );

  let health: unknown[] = [];
  let refundsOwed = 0;
  try {
    health = await listProviderHealth();
    refundsOwed = (await listRefundsOwed(500)).length;
  } catch (e) {
    console.warn("[offramp/health] store read failed:", (e as Error).message);
  }

  return NextResponse.json({
    ok: true,
    gates: {
      // The product gate. FAILS CLOSED: open only on an explicit affirmative
      // FEATURE_CASHOUT value.
      cashoutOpen: cashoutOpen(),
      stubsAllowed: stubsAllowed(),
    },
    providers: allProviders().map((p) => {
      const ready = p.configured();
      return {
        id: p.id,
        displayName: p.displayName,
        live: p.live,
        currencies: p.currencies,
        configured: ready.ok,
        reason: ready.ok ? null : ready.reason,
      };
    }),
    corridors,
    breakers: health,
    refundsOwed,
  });
}

export async function POST(req: Request) {
  const unauthorized = requireCron(req);
  if (unauthorized) return unauthorized;
  const provider = new URL(req.url).searchParams.get("reset")?.trim();
  if (!provider) {
    return NextResponse.json({ error: "pass ?reset=<providerId>" }, { status: 400 });
  }
  await resetProviderHealth(provider);
  console.log(`[offramp/health] circuit manually reset for provider=${provider}`);
  return NextResponse.json({ ok: true, reset: provider });
}
