import { NextResponse } from "next/server";
import { sui, network } from "@/lib/sui";
import { onara } from "@/lib/onara";
import { memoTtl } from "@/lib/perf-cache";
import { ensurePaymentRegistry } from "@/lib/pk-bootstrap";
import { initNaviAdapter } from "@/lib/navi-supply";
import { getCurrentEpoch } from "@/lib/sui-epoch";
import { rateLimitAsync, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * POST /api/zk/warmup
 *
 * Pre-populates the server-side caches that `/api/zk/sponsor` consults on
 * every send: Onara sponsor address and Sui reference gas price. Both
 * round-trips otherwise add ~700ms each to the *first* send of a session.
 *
 * Called from <ProofWarmer/> on dashboard load, by the time the user
 * actually taps Send, both caches are hot and `tx.build` is roughly 3x
 * faster.
 *
 * No auth needed. The values are global, not per-user.
 */
export async function POST(req: Request) {
  // Per-IP rate limit (F15): this route is unauthenticated and does Onara +
  // chain + NAVI-init work, so without a cap it's a cost-amplification / DDoS
  // target. Generous (dashboard load fires it once) but bounded.
  const rl = await rateLimitAsync({ key: `zk-warmup:${getClientIp(req)}`, limit: 60, windowSec: 60 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } }
    );
  }
  const onaraUrl = process.env.ONARA_URL;
  if (!onaraUrl) {
    return NextResponse.json({ ok: false, error: "no onara" }, { status: 503 });
  }
  const client = sui();
  const onaraClient = onara();
  const net = network();

  const t0 = Date.now();
  try {
    // Onara status + Sui gas price warm in parallel with the Payment Kit
    // registry check. The PK ensure is the slow leg on a cold boot (it
    // mints if missing), but after the first call it's a memo cache hit
    // and adds <1ms. We don't `await` PK alongside the two fast checks -
    // we let it run separately so a missing operator key doesn't fail
    // the whole warmup (sends still work without receipts).
    // Pre-warm everything the Send hot path consumes:
    //   - Onara sponsor status (60s memo, ~200–500ms cold)
    //   - Sui reference gas price (1.5s memo, ~150–300ms cold)
    //   - Sui current epoch (memo'd inside getCurrentEpoch, ~150–300ms cold)
    //   - NAVI adapter init (~400–900ms cold; only matters when round-up is
    //     on, but pays for itself anyway since the adapter is shared with
    //     the Earn screen)
    //
    // Each leg is independently `catch`ed so one slow upstream doesn't
    // stall the whole warmup. The Send path will retry any miss anyway.
    const naviPromise = initNaviAdapter().catch(() => false);
    const epochPromise = getCurrentEpoch().catch(() => null);
    await Promise.all([
      memoTtl(`onara:status:${onaraUrl}`, 60_000, () => onaraClient.status()),
      memoTtl(`sui:gas-price:${net}`, 1_500, () =>
        client.getReferenceGasPrice()
      ),
      epochPromise,
      naviPromise,
    ]);
    // Wait for the registry bootstrap so we can tell the client whether
    // Payment Kit receipts are safe to attach to the next send. A failure
    // here is non-fatal, sends will fall back to plain transfers.
    let pkReady = false;
    try {
      const r = await ensurePaymentRegistry();
      pkReady = r.ok;
    } catch (err) {
      console.warn(
        `[zk/warmup] ensurePaymentRegistry failed: ${(err as Error).message}`
      );
    }
    const naviReady = await naviPromise;
    console.log(
      `[zk/warmup] caches warmed in ${Date.now() - t0}ms · pkReady=${pkReady} · naviReady=${naviReady}`
    );
    return NextResponse.json({ ok: true, pkReady, naviReady });
  } catch {
    return NextResponse.json({ ok: false, pkReady: false });
  }
}
