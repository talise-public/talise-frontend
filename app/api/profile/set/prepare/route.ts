import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { denyUnlessAppApproved } from "@/lib/app-access";
import { rateLimitAsync } from "@/lib/rate-limit";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { sui } from "@/lib/sui";
import { onara } from "@/lib/onara";
import { memoTtl } from "@/lib/perf-cache";
import { gql } from "@/lib/sui-graphql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PKG = process.env.PROFILE_PACKAGE_ID;
const CLOCK = "0x6";
const GAS_BUDGET_MIST = 40_000_000n; // 0.04 SUI, sponsor covers actual gas
const MAX_AVATAR = 512;
const MAX_CONFIG = 1024;

// One GraphQL read to find the user's existing Profile (owned, one per user) so
// this route is STATELESS, no DB column, no client-side id tracking, and no
// duplicate profiles. Fails open (→ create) if the read errors.
const OWNED_PROFILE_QUERY = /* GraphQL */ `
  query OwnedProfile($owner: SuiAddress!, $type: String!) {
    address(address: $owner) {
      objects(first: 1, filter: { type: $type }) {
        nodes { address }
      }
    }
  }
`;

async function findProfile(owner: string): Promise<string | null> {
  try {
    const r = await gql<{
      address: { objects: { nodes: Array<{ address: string }> } } | null;
    }>(OWNED_PROFILE_QUERY, { owner, type: `${PKG}::profile::Profile` });
    return r?.address?.objects?.nodes?.[0]?.address ?? null;
  } catch {
    return null;
  }
}

/**
 * POST /api/profile/set/prepare, build a sponsor-ready PTB that records the
 * user's profile picture ON-CHAIN, gaslessly (Onara pays gas; the user signs).
 *
 * Body: { avatar: string, config: string }   (config = small JSON: colour + bg)
 * Returns base64 `bytes` the iOS app signs and forwards to
 * /api/zk/sponsor-execute, identical to the goals/streams sponsored rail.
 *
 * First time (no Profile yet) builds `profile::create` + transfer-to-owner;
 * afterwards `profile::set` on the existing object. Gated on PROFILE_PACKAGE_ID
 * → 503 otherwise, in which case the app keeps the picture purely local.
 */
export async function POST(req: Request) {
  if (!PKG) {
    return NextResponse.json(
      { error: "On-chain profiles aren't enabled yet.", code: "PROFILE_DISABLED" },
      { status: 503 },
    );
  }
  const onaraUrl = process.env.ONARA_URL;
  if (!onaraUrl) {
    return NextResponse.json({ error: "ONARA_URL not configured" }, { status: 503 });
  }

  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const denied = await denyUnlessAppApproved(userId);
  if (denied) return denied;
  const rl = await rateLimitAsync({ key: `profile:user:${userId}`, limit: 30, windowSec: 3600 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 3600) } },
    );
  }
  const user = await userById(userId);
  if (!user?.sui_address) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  let body: { avatar?: string; config?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const avatar = String(body.avatar ?? "").slice(0, MAX_AVATAR);
  const config = String(body.config ?? "").slice(0, MAX_CONFIG);
  if (!avatar) {
    return NextResponse.json({ error: "avatar required" }, { status: 400 });
  }

  try {
    const onaraClient = onara();
    const client = sui();
    const sponsorPromise = memoTtl(`onara:status:${onaraUrl}`, 60_000, () =>
      onaraClient.status(),
    );
    const gasPricePromise = memoTtl(`sui:gas-price:profile`, 1_500, async () => {
      const r = await client.getReferenceGasPrice();
      return r.referenceGasPrice;
    });
    const existing = await findProfile(user.sui_address);

    const tx = new Transaction();
    tx.setSender(user.sui_address);
    if (existing) {
      tx.moveCall({
        target: `${PKG}::profile::set`,
        arguments: [
          tx.object(existing),
          tx.pure.string(avatar),
          tx.pure.string(config),
          tx.object(CLOCK),
        ],
      });
    } else {
      const [profile] = tx.moveCall({
        target: `${PKG}::profile::create`,
        arguments: [
          tx.pure.string(avatar),
          tx.pure.string(config),
          tx.object(CLOCK),
        ],
      });
      tx.transferObjects([profile], tx.pure.address(user.sui_address));
    }

    const [{ address: sponsor }, gasPrice] = await Promise.all([
      sponsorPromise,
      gasPricePromise,
    ]);
    tx.setGasOwner(sponsor);
    tx.setGasPrice(BigInt(gasPrice));
    tx.setGasBudget(GAS_BUDGET_MIST);
    const bytes = await tx.build({ client: client as never });

    return NextResponse.json({
      bytes: toBase64(bytes),
      mode: "sponsored",
      op: existing ? "set" : "create",
    });
  } catch (err) {
    const msg = (err as Error).message ?? "build failed";
    console.warn(`[profile/set/prepare] user=${userId} failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
