import { NextResponse } from "next/server";
import { readEntryIdFromRequest } from "@/lib/mobile-sessions";
import { userById } from "@/lib/db";
import { gql } from "@/lib/sui-graphql";

export const runtime = "nodejs";

/**
 * GET /api/me/nfts
 *
 * The signed-in user's display-bearing Sui objects (NFTs), for picking a
 * profile picture. Reads owned objects via Sui GraphQL and keeps only those
 * with a resolvable `image_url` in their on-chain Display. `ipfs://` is
 * rewritten to a public gateway so the URL loads directly in the app.
 *
 * Returns: { nfts: [{ objectId, name, imageUrl }] }
 */
type GqlObjects = {
  address?: {
    objects?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      nodes?: Array<{
        address?: string;
        display?: Array<{ key?: string; value?: string | null }> | null;
      }>;
    };
  };
};

const QUERY = `
  query OwnedNfts($addr: SuiAddress!, $cursor: String) {
    address(address: $addr) {
      objects(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { address display { key value } }
      }
    }
  }
`;

function resolveUrl(raw: string): string {
  const u = raw.trim();
  if (u.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${u.slice("ipfs://".length)}`;
  return u;
}

export async function GET(req: Request) {
  const userId = await readEntryIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const user = await userById(userId);
  if (!user?.sui_address) return NextResponse.json({ nfts: [] });

  const out: Array<{ objectId: string; name: string; imageUrl: string }> = [];
  try {
    let cursor: string | null = null;
    // Walk up to 3 pages (150 objects), plenty for an avatar picker.
    for (let page = 0; page < 3; page++) {
      const data: GqlObjects = await gql<GqlObjects>(QUERY, {
        addr: user.sui_address,
        cursor,
      });
      const conn = data.address?.objects;
      for (const node of conn?.nodes ?? []) {
        const disp = node.display ?? [];
        const get = (k: string) =>
          disp.find((d) => d.key === k)?.value?.toString().trim() || "";
        const img = get("image_url");
        if (!img || !node.address) continue; // only objects with a picture
        out.push({
          objectId: node.address,
          name: get("name") || "NFT",
          imageUrl: resolveUrl(img),
        });
      }
      if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
      cursor = conn.pageInfo.endCursor;
    }
  } catch (e) {
    console.warn(`[me/nfts] fetch failed user=${userId}: ${(e as Error).message}`);
    // Soft-fail: an empty list just means "no NFTs to pick from".
    return NextResponse.json({ nfts: [] });
  }

  return NextResponse.json({ nfts: out.slice(0, 120) });
}
