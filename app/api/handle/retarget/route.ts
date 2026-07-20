import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { SuinsTransaction } from "@mysten/suins";
import { sui } from "@/lib/sui";
import { suins } from "@/lib/suins-operator";
import { findAllTaliseSubnamesForOwner } from "@/lib/suins-lookup";
import { onara } from "@/lib/onara";
import { requireAppAttestStructural } from "@/lib/app-attest";
import { memoTtl } from "@/lib/perf-cache";

export const runtime = "nodejs";

/**
 * POST /api/handle/retarget
 *
 * Re-points the SuiNS `targetAddress` of every `*.talise.sui` subname
 * the user owns at their current `sui_address`. Replaces the manual
 * `scripts/fix-suins-targets.mjs` operator runbook with a one-tap
 * Profile UI flow.
 *
 * Why this exists: subname NFTs minted before the wallet-consolidation
 * (or any time the user's primary address changes) keep their old
 * `targetAddress` field, so `name@talise.sui` routes to the OLD
 * address rather than the wallet the user is signed in to today. The
 * NFT owner can update the target via
 * `SuinsTransaction.setTargetAddress({nft, address, isSubname:true})`.
 *
 * Modes:
 *   probe=1, no PTB build. Returns the diff (names + current targets)
 *     so the iOS sheet can render "name → 0x… ✗" vs "name → 0x… ✓"
 *     before the user taps the CTA.
 *   default, full Onara-sponsored build. Returns the bytes for iOS
 *     to sign and forward to `/api/zk/sponsor-execute` with
 *     `meta.kind = "retarget"`.
 *
 * Sponsorship rail: Onara, mirroring `/api/send/sponsor-prepare`'s
 * sponsored branch. The PTB is wallet maintenance, no value moves -
 * so the user pays nothing.
 *
 * Cap: 10s outer (mirrors the `/api/earn/withdraw/prepare` pattern).
 * Each per-name `getNameRecord` read is wrapped in a 3s `withTimeout`
 * so one slow on-chain read can't hold the whole route.
 */

const OUTER_CAP_MS = 10_000;
const PER_NAME_READ_MS = 3_000;

type NameDiff = {
  nft: string;
  name: string;
  fromTarget: string | null;
};

/**
 * Per-leg timeout wrapper. Returns `null` on timeout / error so the
 * route can decide whether to surface a 504 (timeout on critical
 * reads) or just skip the name (transient RPC hiccup on a single
 * read shouldn't block the rest).
 *
 * Mirrors the `withTimeout` pattern in `lib/activity.ts` and
 * `/api/earn/withdraw/prepare`, local copy keeps a wedged retarget
 * read from sharing a stack frame with the activity feed.
 */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  leg: string
): Promise<{ ok: true; value: T } | { ok: false; timeout: boolean; leg: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[handle/retarget] ${leg} timed out after ${ms}ms`);
      resolve({ ok: false, timeout: true, leg });
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve({ ok: true, value: v });
      },
      (e) => {
        clearTimeout(timer);
        console.warn(
          `[handle/retarget] ${leg} errored: ${(e as Error).message ?? String(e)}`
        );
        resolve({ ok: false, timeout: false, leg });
      }
    );
  });
}

export async function POST(req: Request) {
  // App Attest required on the build path (money-adjacent, Onara
  // sponsors gas). Probe path is also gated for consistency.
  const attestBlock = requireAppAttestStructural(req);
  if (attestBlock) return attestBlock;

  const userId = await readEntryIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const user = await userById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const isProbe = url.searchParams.get("probe") === "1";

  // For the build path we need ONARA_URL up-front; probe path is
  // read-only so we don't require it.
  if (!isProbe) {
    if (!process.env.ONARA_URL) {
      return NextResponse.json(
        { error: "ONARA_URL not configured" },
        { status: 503 }
      );
    }
  }

  const TIMEOUT_MARKER = Symbol("retarget-outer-timeout");
  let outerTimer: ReturnType<typeof setTimeout> | undefined;
  const outerTimeout = new Promise<typeof TIMEOUT_MARKER>((resolve) => {
    outerTimer = setTimeout(() => resolve(TIMEOUT_MARKER), OUTER_CAP_MS);
  });

  const work = (async (): Promise<NextResponse> => {
    const t0 = Date.now();
    const myAddress = user.sui_address.toLowerCase();

    // 1. Enumerate owned `*.talise.sui` subname NFTs. The helper
    //    already pages owned objects and resolves each name's current
    //    target, we'd repeat that work if we didn't use it. The
    //    helper itself catches per-name errors so this never throws.
    const owned = await findAllTaliseSubnamesForOwner(user.sui_address);

    if (owned.length === 0) {
      console.log(
        `[handle/retarget] user=${userId} owns 0 *.talise.sui subnames, alreadyAligned`
      );
      return NextResponse.json({ alreadyAligned: true, names: [] });
    }

    // 2. Compute the diff. `findAllTaliseSubnamesForOwner` already
    //    populated `targetAddress` per name via SuinsClient.getNameRecord
    //  , but it doesn't apply a timeout. We re-read here under a 3s
    //    per-name cap so a sluggish gRPC node can't extend the route
    //    past our 10s outer cap.
    //
    //    For names where the targetAddress already matches the user's
    //    sui_address, we skip, no point appending a no-op MoveCall.
    const suinsClient = suins();
    const allNames: NameDiff[] = [];
    const needUpdate: NameDiff[] = [];

    for (const o of owned) {
      const readRes = await withTimeout(
        suinsClient.getNameRecord(o.fullName),
        PER_NAME_READ_MS,
        `getNameRecord:${o.fullName}`
      );
      if (!readRes.ok && readRes.timeout) {
        // Critical read timed out, surface a clean 504 rather than
        // returning a half-baked diff that could lead the user into
        // signing a PTB that re-targets names whose current target
        // we don't actually know.
        return NextResponse.json(
          {
            error:
              "On-chain SuiNS reads are slow right now. Try again in a few seconds.",
            code: "RETARGET_TIMEOUT",
            leg: readRes.leg,
          },
          { status: 504 }
        );
      }
      const cur =
        readRes.ok && readRes.value ? readRes.value.targetAddress ?? null : null;
      const diff: NameDiff = {
        nft: o.nftId,
        name: o.fullName,
        fromTarget: cur,
      };
      allNames.push(diff);
      if (!cur || cur.toLowerCase() !== myAddress) {
        needUpdate.push(diff);
      }
    }

    // 3. Probe-only path, never build a PTB, just describe the diff.
    //    Sheet uses this on appear to render the per-name state with
    //    red/green badges before the user taps the CTA.
    if (isProbe) {
      const aligned = needUpdate.length === 0;
      console.log(
        `[handle/retarget probe] user=${userId} total=${allNames.length} need=${needUpdate.length} alreadyAligned=${aligned}`
      );
      if (aligned) {
        return NextResponse.json({ alreadyAligned: true, names: allNames });
      }
      return NextResponse.json({
        alreadyAligned: false,
        names: allNames,
        needUpdate: needUpdate.length,
      });
    }

    // 4. Build path, if every name is already aligned, no work to do.
    //    Return the same `alreadyAligned: true` shape so the sheet can
    //    render the green ✓ state without a second round-trip.
    if (needUpdate.length === 0) {
      console.log(
        `[handle/retarget] user=${userId} every *.talise.sui already aligned, nothing to build`
      );
      return NextResponse.json({ alreadyAligned: true, names: allNames });
    }

    // 5. Build the Onara-sponsored PTB. One `setTargetAddress` MoveCall
    //    per name needing update, see `scripts/fix-suins-targets.mjs`
    //    for the canonical shape (the script broadcasts; this route
    //    just prepares the bytes for iOS to sign).
    const onaraClient = onara();
    const client = sui();
    const sponsorPromise = memoTtl(
      `onara:status:${process.env.ONARA_URL}`,
      60_000,
      () => onaraClient.status()
    );
    const gasPricePromise = memoTtl(
      `sui:gas-price:retarget`,
      1_500,
      async () => {
        const r = await client.getReferenceGasPrice();
        return r.referenceGasPrice;
      }
    );

    const tx = new Transaction();
    tx.setSender(user.sui_address);
    const stx = new SuinsTransaction(suinsClient, tx);
    for (const d of needUpdate) {
      stx.setTargetAddress({
        nft: tx.object(d.nft),
        address: user.sui_address,
        isSubname: true,
      });
    }

    const [{ address: sponsor }, gasPrice] = await Promise.all([
      sponsorPromise,
      gasPricePromise,
    ]);
    tx.setGasOwner(sponsor);
    tx.setGasPrice(BigInt(gasPrice));

    const bytes = await tx.build({ client: client as never });
    const tBuilt = Date.now();

    console.log(
      `[handle/retarget] mode=sponsored-retarget user=${userId} names=${needUpdate.length}/${allNames.length} sponsor=${sponsor} gasPrice=${gasPrice} total=${tBuilt - t0}ms`
    );

    return NextResponse.json({
      bytes: toBase64(bytes),
      mode: "sponsored-retarget",
      names: needUpdate,
      sponsor,
      gasPrice: String(gasPrice),
    });
  })();

  const winner = await Promise.race([work, outerTimeout]);
  if (outerTimer) clearTimeout(outerTimer);
  if (winner === TIMEOUT_MARKER) {
    console.warn(
      `[handle/retarget] outer cap fired at ${OUTER_CAP_MS}ms (user=${userId})`
    );
    return NextResponse.json(
      {
        error: "Retarget is taking longer than usual, try again in a few seconds.",
        code: "RETARGET_TIMEOUT",
      },
      { status: 504 }
    );
  }
  return winner as NextResponse;
}
