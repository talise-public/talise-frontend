import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { db, userById } from "@/lib/db";
import { normalizeHandle, RESERVED_USERNAMES } from "@/lib/handle";
import { mintSubname, suins, suinsOperatorEnabled, LowOperatorGasError } from "@/lib/suins-operator";
import { findTaliseSubnameForOwner } from "@/lib/suins-lookup";

export const runtime = "nodejs";

/**
 * POST /api/username/claim   body: { username: string }
 *
 * SuiNS-only. We sign a subname mint with the operator key that holds
 * `talise.sui`, transfer the resulting NFT to the caller's Sui address,
 * and return the digest + nft id. Nothing is written to our DB -
 * authoritative state is the on-chain SuiNS record.
 */
export async function POST(req: Request) {
  if (!suinsOperatorEnabled()) {
    return NextResponse.json(
      { error: "SuiNS operator not configured" },
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

  // One handle per user. If they already own a `*.talise.sui` subname NFT,
  // don't mint another, but treat the claim as a SUCCESS for the name they
  // own (idempotent). This is the recovery path for the 2026-06-12 Apple
  // sign-in incident: the first claim's mint LANDED on-chain but the
  // response was lost, so every retry 409'd "already minted" while the
  // client believed the claim never happened and the DB binding never ran.
  const existing = await findTaliseSubnameForOwner(user.sui_address);
  if (existing) {
    await backfillTaliseUsername(userId, existing.username);
    return NextResponse.json({
      ok: true,
      username: existing.username,
      existing: true,
    });
  }

  let body: { username?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const username = normalizeHandle(body.username ?? "");
  if (!username) {
    return NextResponse.json(
      { error: "username must be 3-20 chars of a-z, 0-9, _" },
      { status: 400 }
    );
  }
  if (RESERVED_USERNAMES.has(username)) {
    return NextResponse.json({ error: "that username is reserved" }, { status: 400 });
  }

  // On-chain availability, defends against the user re-submitting a stale
  // form after someone else minted the same name. The mint itself would
  // revert in this case too, but a 409 here is a cleaner UX.
  try {
    const taken = await suins().getNameRecord(`${username}.talise.sui`);
    if (taken) {
      // Idempotency: "taken" by THE CALLER is a success, not a conflict -
      // the earlier ownership check can miss a just-minted NFT behind a
      // caching read layer, but the name record's target is authoritative.
      const target = (taken as { targetAddress?: string | null }).targetAddress;
      if (
        typeof target === "string" &&
        target.toLowerCase() === user.sui_address.toLowerCase()
      ) {
        await backfillTaliseUsername(userId, username);
        return NextResponse.json({ ok: true, username, existing: true });
      }
      return NextResponse.json(
        { error: "that username is already minted on SuiNS" },
        { status: 409 }
      );
    }
  } catch (e) {
    // SuinsClient throws when the name isn't minted, that's the happy path
    // here, NOT an error. Real RPC errors get surfaced by the mint attempt.
    // Error message arrives as either "does not exist", "not exist", or
    // "Object 0x… not found" depending on transport / SDK version. Match
    // any of those as "name is free".
    const msg = (e as Error).message ?? "";
    if (!/(not exist|not found)/i.test(msg)) {
      // genuine RPC failure, log + continue; mint will surface it cleanly
    }
  }

  // Per-user concurrency gate. A double-tap on the Claim button (or a
  // misbehaving client retrying mid-mint) would otherwise pass the
  // ownership + availability checks twice and broadcast two mint txs.
  // The second always reverts on chain (good, we don't end up with
  // duplicate NFTs), but the response is an opaque 502 from the
  // already-spent SuiNS field. An in-process Map of inflight promises
  // collapses concurrent calls for the same user into one mint.
  return await singleflight(userId, async () => {
    try {
      const { digest, subnameNftId } = await mintSubname({
        username,
        userAddress: user.sui_address,
      });
      // Bind into Postgres so /api/me's fast path knows the handle even if
      // the reverse-SuiNS lookup lags behind a caching read layer (the
      // mint-succeeded-but-profile-says-claim-your-name gap).
      await backfillTaliseUsername(userId, username);
      return NextResponse.json({ ok: true, username, digest, subnameNftId });
    } catch (err) {
      // Low operator gas: not a real failure, tell the user to retry shortly
      // (a 503 the client can surface calmly), don't dump on-chain detail.
      if (err instanceof LowOperatorGasError) {
        console.error(
          `[username/claim] mint paused (gas low) user=${userId} handle=${username}, ask retry`
        );
        return NextResponse.json(
          {
            error:
              "We're finalizing names on-chain, try claiming again in a few minutes.",
            retry: true,
          },
          { status: 503 }
        );
      }
      const reason = (err as Error).message ?? "subname mint failed";
      return NextResponse.json(
        { error: `On-chain subname mint failed: ${reason}` },
        { status: 502 }
      );
    }
  });
}

/// Write the claimed bare handle into `users.talise_username`, the column
/// /api/me's fast path reads. COALESCE keeps an already-bound handle; never
/// throws (the on-chain mint is the source of truth, a DB hiccup must not
/// fail the claim).
async function backfillTaliseUsername(userId: number, username: string): Promise<void> {
  try {
    await db().execute({
      sql: `UPDATE users
              SET talise_username = COALESCE(talise_username, $1),
                  suins_subname = COALESCE(suins_subname, $2)
            WHERE id = $3`,
      args: [username, `${username}.talise.sui`, userId],
    });
  } catch (e) {
    console.warn(
      `[username/claim] talise_username backfill failed user=${userId}: ${(e as Error).message}`
    );
  }
}

/// Single-flight gate keyed by user id. Subsequent calls for the same
/// user while the first is in-flight await the same result. Resets
/// when the inflight settles. Module-scope so it survives across
/// requests within one server process, good enough until we're
/// running multiple instances behind a load balancer; at that point
/// we'd swap this for a Redis lock or DB advisory lock.
const inflight = new Map<number, Promise<NextResponse>>();
async function singleflight(
  userId: number,
  fn: () => Promise<NextResponse>
): Promise<NextResponse> {
  // Multiple awaiters on the same Promise all get the same resolved
  // NextResponse, fine because we never mutate the response after
  // construction. No .clone() needed.
  const existing = inflight.get(userId);
  if (existing) return existing;
  const p = fn().finally(() => inflight.delete(userId));
  inflight.set(userId, p);
  return p;
}
