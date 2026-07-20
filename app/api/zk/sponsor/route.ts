import { NextResponse } from "next/server";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { rateLimitAsync } from "@/lib/rate-limit";
import { userById } from "@/lib/db";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { Transaction } from "@mysten/sui/transactions";
import { sui, network } from "@/lib/sui";
import { onara } from "@/lib/onara";
import { memoTtl } from "@/lib/perf-cache";
import { ensurePaymentRegistry } from "@/lib/pk-bootstrap";

export const runtime = "nodejs";

/**
 * POST /api/zk/sponsor
 *
 * Trip 1 of the sponsored flow. Our gas station is Onara
 * (https://github.com/unconfirmedlabs/onara), a Cloudflare-Workers policy
 * server that signs as gasOwner. Client sends the transaction-kind bytes;
 * we ask Onara for the sponsor address, build the full TransactionData with
 * the sponsor as gasOwner, and return the bytes for the user to sign.
 *
 * The actual sponsor signing happens server-side in Onara when we POST the
 * user-signed bytes to /sponsor, Onara enforces policy, signs, broadcasts.
 */
export async function POST(req: Request) {
  const onaraUrl = process.env.ONARA_URL;
  if (!onaraUrl) {
    return NextResponse.json(
      { error: "ONARA_URL not configured" },
      { status: 503 }
    );
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  // Private-beta guardrail: signed-in is not enough, the account must be on
  // the app allowlist before it can originate any value-moving call.
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  // Per-user anti-abuse cap. Sponsoring does real work (RPC + Onara round-trips)
  // even when the user never submits the signed tx, so an approved-but-abusive
  // client could otherwise burn our gas-station/RPC budget by hammering trip 1.
  // 120/hr is far above any legitimate use (downstream gasless-submit is 30/hr).
  const rl = await rateLimitAsync({ key: `zk-sponsor:user:${userId}`, limit: 120, windowSec: 3600 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } }
    );
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: { transactionKindB64?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!body.transactionKindB64) {
    return NextResponse.json(
      { error: "missing transactionKindB64" },
      { status: 400 }
    );
  }

  try {
    const t0 = Date.now();
    const onaraClient = onara();
    const client = sui();
    const net = network();

    // Make sure the Payment Kit registry exists on chain, otherwise the
    // user's tx would abort the moment it calls processRegistryPayment.
    // Idempotent + memoized: after the first successful call this is a
    // <1ms cache hit. Fired alongside the warmup checks so we don't pay
    // its cost serially on every send.
    const ensureRegistry = ensurePaymentRegistry().catch((err) => {
      console.warn(
        `[zk/sponsor] ensurePaymentRegistry failed: ${(err as Error).message}`
      );
    });

    // Parallelize the two cold round-trips. Both are cached for 60s, the
    // sponsor address rarely changes and reference gas price is
    // epoch-scoped (~24h). On cache hits each resolves in <1ms.
    const [{ address: sponsor }, gasPrice] = await Promise.all([
      memoTtl(`onara:status:${onaraUrl}`, 60_000, () => onaraClient.status()),
      memoTtl(`sui:gasPrice:${net}`, 60_000, async () => {
        // gRPC `getReferenceGasPrice` returns `{ referenceGasPrice: string }`.
        const r = await client.getReferenceGasPrice();
        return r.referenceGasPrice;
      }),
      ensureRegistry,
    ]);
    const tStatus = Date.now();

    const tx = Transaction.fromKind(fromBase64(body.transactionKindB64));
    tx.setSender(user.sui_address);
    tx.setGasOwner(sponsor);
    // Pre-set gas price so `tx.build()` skips the `getReferenceGasPrice`
    // RPC. Sponsor's gas coin lookup still happens, Onara doesn't expose
    // its coin objectRefs, so we can't skip that part.
    tx.setGasPrice(BigInt(gasPrice));
    // Explicit gas budget, see web/app/api/send/sponsor-prepare/route.ts for
    // the full rationale. Without it the SDK can auto-select only the sponsor's
    // dust Coin<SUI> and bake a budget it can't cover → Onara simulate rejects
    // with "Insufficient gas". A generous fixed cap forces selection to pull in
    // the main coin; the sponsor is charged only the actual gas used.
    tx.setGasBudget(60_000_000n);

    const bytes = await tx.build({ client: client as never });
    const tBuild = Date.now();

    console.log(
      `[zk/sponsor] status+price(par)=${tStatus - t0}ms · tx.build=${tBuild - tStatus}ms · total=${tBuild - t0}ms`
    );
    // Verification log, uniform shape across every sponsored leg so
    // production routing (earn supply / withdraw / withdraw-earned, plus
    // any future sponsored consumer of this endpoint) is greppable as
    // `mode=sponsored sponsor=<addr> gasPrice=<n>`. Per the
    // 2026-05-29 sponsorship-matrix directive.
    console.log(
      `[zk/sponsor] mode=sponsored sponsor=${sponsor} gasPrice=${gasPrice}`
    );
    return NextResponse.json({ bytes: toBase64(bytes) });
  } catch (err) {
    // Forward the upstream message so iOS can surface the real failure
    // reason (Onara denials, build-time abort codes), but also log
    // server-side with the userId for traceability.
    const msg = (err as Error).message ?? "sponsor failed";
    console.warn(`[zk/sponsor] user=${userId} failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
