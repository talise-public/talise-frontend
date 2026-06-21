import { NextResponse } from "next/server";

import {
  DEFAULT_FUNDING_METHOD,
  listFundingMethods,
} from "@/lib/onramp/funding-methods";
import { circleMintConfigured } from "@/lib/onramp/circle-mint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/onramp/methods[?amount=<usd>]
 *
 * Surfaces the available on-ramp funding methods and their cost so the client
 * can DEFAULT to bank funding (master plan §6: card economics are negative;
 * bank/ACH must be the default and card a surcharged convenience tier).
 *
 * Static metadata is always returned. When `?amount=` is a positive USD value,
 * each method also carries a `quote` with the exact fee for that amount — card
 * shows ~2.9% + $0.30 passed through explicitly, bank rails show $0.
 *
 * Returns the methods in display order (bank first, card last) plus the
 * `defaultMethod` so the client never re-encodes that policy itself. Public:
 * this is non-sensitive pricing metadata, like /api/fx.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const amountParam = url.searchParams.get("amount");

  let amountUsd: number | undefined;
  if (amountParam !== null) {
    const parsed = Number(amountParam);
    if (Number.isFinite(parsed) && parsed > 0) {
      amountUsd = Math.round(parsed * 100) / 100;
    }
  }

  const methods = listFundingMethods(amountUsd);

  return NextResponse.json({
    defaultMethod: DEFAULT_FUNDING_METHOD,
    // True once a real Circle Mint relationship is configured; bank rails
    // settle USD → USDC on Sui at par through it (mock until then).
    circleMintLive: circleMintConfigured(),
    amountUsd: amountUsd ?? null,
    methods,
  });
}
