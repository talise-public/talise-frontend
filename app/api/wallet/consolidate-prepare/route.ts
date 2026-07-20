import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { sui, network } from "@/lib/sui";
import { USDSUI_TYPE } from "@/lib/usdsui";
import { onara } from "@/lib/onara";
import { memoTtl } from "@/lib/perf-cache";

export const runtime = "nodejs";

/**
 * POST /api/wallet/consolidate-prepare
 *
 * One-time "Enable gasless balance" action. The user holds USDsui inside
 * `Coin<USDSUI>` objects rather than the Address Balance accumulator -
 * which means the gasless rail (which can only spend out of the
 * accumulator) is blind to those funds. This route builds an Onara-
 * sponsored PTB that, for each Coin<USDSUI> object the user owns:
 *
 *   bal = 0x2::coin::into_balance<USDSUI>(coin)
 *   0x2::balance::send_funds<USDSUI>(bal, sender)
 *
 * The Coin object is burned; its balance is deposited into the sender's
 * own Address Balance accumulator.
 *
 * IMPORTANT CAVEAT (2026-05-29): consolidation alone does NOT make
 * future sends gasless. Sui's gasless rail requires every PTB to carry
 * EITHER an address-owned Coin input OR a ValidDuring expiration. After
 * consolidation the user has no Coin<USDsui> anchor, and the
 * validator's ValidDuring path is broken upstream
 * ("unknown TransactionExpirationKind" on gRPC). So a fully-consolidated
 * wallet trips
 * `GASLESS_NEEDS_ANCHOR` on the next send, which now falls through to
 * `mode: "sponsored-anchor-fallback"` (Onara-sponsored Payment Kit) so
 * the tx still lands.
 *
 * Practical use today: this route is useful for users whose USDsui is
 * spread across many Coin<USDsui> objects and want a single
 * accumulator total for accounting purposes, but it does NOT unblock
 * gasless on its own. iOS no longer offers this as a "fix it to make
 * sends gasless" tap. When Sui ships either (a) a public Coin→
 * accumulator deposit on the gasless allowlist or (b) a working
 * ValidDuring path, this route + its iOS surface can be re-enabled
 * as the canonical "make every send gasless" path.
 *
 * Why Onara sponsorship?
 *   The PTB calls `0x2::coin::into_balance` which is NOT on the gasless
 *   allowlist (proved in docs/sui-rpc-migration/gasless-notes.md). It
 *   needs real gas (~$0.001 SUI). This is the one place we use Onara
 *   intentionally, it's a wallet-setup operation, not a transfer, and
 *   the user pays nothing.
 *
 * Idempotent. If the user already holds zero Coin<USDSUI> objects (a
 * second tap after one consolidation already landed) the route returns
 * 200 `{ alreadyGasless: true }` and does not build a tx.
 *
 * iOS signs the returned `bytes` and forwards to /api/zk/sponsor-execute
 * with `meta.kind = "consolidate"`, no new execute route needed.
 */

const SUPPORTED_ASSETS = new Set(["USDsui"]);

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
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: { asset?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const asset = body.asset ?? "USDsui";
  if (!SUPPORTED_ASSETS.has(asset)) {
    return NextResponse.json(
      { error: `asset must be one of ${[...SUPPORTED_ASSETS].join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const t0 = Date.now();
    const client = sui();

    // 1. Enumerate Coin<USDSUI> objects + read the accumulator amount.
    //    The accumulator-shadow detection requires BOTH:
    //      a. `getBalance({owner, coinType}).fundsInAddressBalance`, the
    //         µ amount sitting in the user's address-balance accumulator.
    //      b. `listCoins({owner, coinType})`, every Coin<T> the user
    //         owns PLUS one synthetic row representing the accumulator
    //         surface. The synthetic row reports
    //           type: 0x2::coin::Coin<USDSUI>
    //           balance: <exactly fundsInAddressBalance>
    //           version: much older than peer real coins
    //         so a naive "filter on type or getObject" check passes it
    //         through (it IS a real on-chain object, just not usable
    //         as a PTB input). The PTB then fails the tx with
    //         `Object … not found` at build/simulate time.
    //
    //    Robust filter: drop the row whose `balance === fundsInAddressBalance`
    //    AND whose version is dramatically older than the other coins
    //    (the gap is millions of units in practice, empirically ~200M).
    const balancesPromise = client.getBalance({
      owner: user.sui_address,
      coinType: USDSUI_TYPE,
    });
    const coinsPromise = client.listCoins({
      owner: user.sui_address,
      coinType: USDSUI_TYPE,
      limit: 200,
    });
    const [balancesRes, coinsRes] = await Promise.all([
      balancesPromise,
      coinsPromise,
    ]);
    // gRPC shapes: getBalance returns `{ balance: { addressBalance,
    // coinBalance, balance, coinType } }`. The accumulator amount is
    // `addressBalance` (µ); falls back to "0" if absent.
    const accumulatorMicros = BigInt(
      ((balancesRes as { balance?: { addressBalance?: string } }).balance
        ?.addressBalance ?? "0") || "0"
    );
    type ListCoinObject = { objectId?: string; balance?: string; type?: string; version?: string | number };
    const rawCoins = (
      (coinsRes as { objects?: ListCoinObject[] }).objects ?? []
    ).map((c) => ({
      objectId: c.objectId as string,
      balance: BigInt(c.balance ?? "0"),
      type: (c.type as string | undefined) ?? "",
      version: BigInt(String(c.version ?? "0")),
    }));

    // Drop the accumulator-shadow row.
    //
    // Two-signal detection (defense-in-depth):
    //   • balance EXACTLY matches the accumulator amount, AND
    //   • this row's version is at least 1,000,000 units older than the
    //     largest version among the candidates (real Coin objects
    //     trade hands frequently; the shadow doesn't).
    //
    // Only one of these alone is a false positive: a real Coin object
    // can coincidentally have the same balance as the accumulator
    // (rare but possible), and an old untouched Coin can have a very
    // old version. Requiring BOTH signals together is robust.
    const maxVersion = rawCoins.reduce(
      (a, c) => (c.version > a ? c.version : a),
      0n
    );
    const VERSION_GAP_THRESHOLD = 1_000_000n;
    const filteredOfShadow = rawCoins.filter((c) => {
      const balanceMatchesAccumulator =
        accumulatorMicros > 0n && c.balance === accumulatorMicros;
      const versionIsStale =
        maxVersion - c.version > VERSION_GAP_THRESHOLD;
      const isShadow = balanceMatchesAccumulator && versionIsStale;
      if (isShadow) {
        console.log(
          `[consolidate-prepare] dropped accumulator-shadow ${c.objectId.slice(0, 18)}… bal=${c.balance} ver=${c.version} (accumulator=${accumulatorMicros}, maxVer=${maxVersion})`
        );
      }
      return !isShadow;
    });

    // Normalize: lowercase address part of USDSUI_TYPE so we don't reject
    // a valid `0x2::coin::Coin<0x44F838…>` for differing hex case.
    const expectedType = `0x2::coin::Coin<${USDSUI_TYPE}>`.toLowerCase();

    // 2. For each candidate, call getObject and KEEP it only if the
    //    fullnode confirms it exists AND its on-chain type is
    //    `0x2::coin::Coin<USDSUI>`. Anything that throws (= not found)
    //    or whose type differs (= accumulator shadow) is dropped. gRPC
    //    `getObject` THROWS on missing objects (unlike JSON-RPC which
    //    returned `{ data: null }`), so we wrap each in a try/catch.
    //
    //    These checks run in parallel, for the typical user this is at
    //    most a handful of objects and fits inside one round-trip
    //    window.
    const verified = (
      await Promise.all(
        filteredOfShadow.map(async (c) => {
          try {
            const res = await client.getObject({ objectId: c.objectId });
            const onChainType = (
              (res as { object?: { objectType?: string } }).object?.objectType ??
              ""
            ).toLowerCase();
            if (!onChainType) return null;
            // Compare on the lowercased forms. The address part of a
            // Sui type string is hex; the module/name segments are
            // case-sensitive identifiers, but USDSUI is already
            // uppercase on both sides so lowercase is a safe equality.
            if (onChainType !== expectedType) return null;
            return c;
          } catch {
            // Not-found / transient lookup failure → drop. We'd rather
            // skip a coin and consolidate the rest than fail the whole
            // tx on one phantom object.
            return null;
          }
        })
      )
    ).filter((c): c is { objectId: string; balance: bigint; type: string; version: bigint } => c !== null);

    if (verified.length === 0) {
      // Nothing to consolidate. Either the user is already fully on the
      // accumulator (good, every future send is gasless) or they have
      // no USDsui at all. Either way, the right answer to iOS is "this
      // tap was a no-op".
      return NextResponse.json({
        alreadyGasless: true,
        mode: "consolidation",
        coinCount: 0,
        totalMicrosMoved: "0",
      });
    }

    const totalMicros = verified.reduce((acc, c) => acc + c.balance, 0n);

    // 3. Build the consolidation PTB. For each surviving Coin object:
    //      bal = 0x2::coin::into_balance<USDSUI>(coinObject)
    //      0x2::balance::send_funds<USDSUI>(bal, sender)
    //    The first MoveCall burns the Coin and produces a Balance<T>;
    //    the second deposits that Balance into the sender's own
    //    accumulator via the gasless-rail send_funds primitive (which
    //    accepts the sender as recipient, same-address deposits are
    //    legal and land in the accumulator).
    const tx = new Transaction();
    tx.setSender(user.sui_address);

    for (const c of verified) {
      const bal = tx.moveCall({
        target: "0x2::coin::into_balance",
        typeArguments: [USDSUI_TYPE],
        arguments: [tx.object(c.objectId)],
      });
      tx.moveCall({
        target: "0x2::balance::send_funds",
        typeArguments: [USDSUI_TYPE],
        arguments: [bal, tx.pure.address(user.sui_address)],
      });
    }

    // 4. Wrap with Onara as gasOwner. Same shape as sponsor-prepare's
    //    sponsored branch, memoized status() + getReferenceGasPrice()
    //    in parallel, then setGasOwner + setGasPrice, then tx.build()
    //    against the gRPC client.
    const onaraClient = onara();
    const net = network();
    const [{ address: sponsor }, gasPrice] = await Promise.all([
      memoTtl(`onara:status:${onaraUrl}`, 60_000, () => onaraClient.status()),
      memoTtl(`sui:gas-price:${net}`, 1_500, async () => {
        const r = await client.getReferenceGasPrice();
        return r.referenceGasPrice;
      }),
    ]);
    tx.setGasOwner(sponsor);
    tx.setGasPrice(BigInt(gasPrice));

    const bytes = await tx.build({ client: client as never });
    const tBuild = Date.now();

    console.log(
      `[wallet/consolidate-prepare] user=${userId} coins=${verified.length} ` +
        `microsMoved=${totalMicros} build=${tBuild - t0}ms`
    );

    return NextResponse.json({
      bytes: toBase64(bytes),
      mode: "consolidation",
      coinCount: verified.length,
      totalMicrosMoved: totalMicros.toString(),
    });
  } catch (err) {
    // ZERO fallback. This is explicitly NOT a transfer, silently
    // dropping the failure would either pretend a setup operation
    // succeeded (and leave the user permanently stuck in Coin-only
    // state) or charge Onara for a tx the validator never accepted.
    // Surface the raw error to iOS so the UI can show a real reason
    // and the user can try again.
    const msg = (err as Error).message ?? "build failed";
    console.error(
      `[wallet/consolidate-prepare] user=${userId} build failed: ${msg}`
    );
    return NextResponse.json(
      {
        error: "Couldn't enable gasless balance right now. Try again shortly.",
        detail: msg,
        code: "CONSOLIDATE_BUILD_FAILED",
      },
      { status: 400 }
    );
  }
}
