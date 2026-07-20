import "server-only";

import { sui } from "./sui";
import { memoTtl } from "./perf-cache";

/**
 * Reverse SuiNS lookup, given a Sui address, find any `*.talise.sui`
 * subname NFTs that address owns. Pure on-chain; no DB.
 *
 * We page the user's owned objects, filter for any whose `display.name`
 * field ends with `.talise.sui`, and return the first match. This
 * deliberately doesn't hardcode the SubDomainRegistration package id -
 * SuiNS has shipped multiple subdomain packages over time and the type
 * can vary. The `display.name` is set by the SuiNS Move package's
 * display metadata and is stable across versions.
 *
 * Future: if the user holds multiple `*.talise.sui` names, a "set primary"
 * UI can let them pick which to display. For v1, we return the first.
 */

const PARENT_SUFFIX = ".talise.sui";

export type OwnedSubname = {
  /** Bare username, no parent suffix: e.g. "sele". */
  username: string;
  /** SuiNS canonical: e.g. "sele.talise.sui". */
  fullName: string;
  /** Object id of the subname NFT. */
  nftId: string;
};

/**
 * Return EVERY `*.talise.sui` NFT the owner holds, together with the address
 * the SuiNS resolver currently points the name to. Used by the "fix
 * resolution" flow: when a subname was minted before we wired
 * `setTargetAddress` into the mint PTB, the NFT exists but has a null
 * target, these are surfaced here so the user can repair them in one tap.
 */
export type OwnedSubnameWithTarget = OwnedSubname & {
  targetAddress: string | null;
};

/**
 * Extract a display name from a gRPC Object's display.output map.
 * Display v2 emits `{ output: { name: "...", ... } | null, errors }`.
 */
function readDisplayName(
  display: { output: Record<string, unknown> | null; errors: unknown } | null | undefined
): string {
  const v = display?.output?.name;
  return typeof v === "string" ? v : "";
}

export async function findAllTaliseSubnamesForOwner(
  owner: string
): Promise<OwnedSubnameWithTarget[]> {
  const all: OwnedSubname[] = [];
  const client = sui();
  try {
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const r: Awaited<
        ReturnType<typeof client.listOwnedObjects<{ display: true }>>
      > = await client.listOwnedObjects({
        owner,
        limit: 50,
        cursor,
        include: { display: true },
      });
      for (const o of r.objects ?? []) {
        const t = o.type ?? "";
        if (!/subdomain_registration::SubDomainRegistration/.test(t)) continue;
        const name = readDisplayName(o.display);
        if (!name.endsWith(PARENT_SUFFIX)) continue;
        all.push({
          username: name.slice(0, -PARENT_SUFFIX.length),
          fullName: name,
          nftId: o.objectId ?? "",
        });
      }
      // gRPC: no `hasNextPage` flag, stop when cursor is null.
      if (!r.cursor) break;
      cursor = r.cursor;
    }

    // Resolve each name's target address. Stale ones come back as null.
    // Lazy-load @mysten/suins so the cost is paid only when this list is non-empty.
    if (all.length === 0) return [];
    const { SuinsClient } = await import("@mysten/suins");
    const suins = new SuinsClient({
      client: client as never,
      network: "mainnet",
    });
    const out: OwnedSubnameWithTarget[] = [];
    for (const s of all) {
      try {
        const rec = await suins.getNameRecord(s.fullName);
        out.push({ ...s, targetAddress: rec?.targetAddress ?? null });
      } catch {
        out.push({ ...s, targetAddress: null });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Cached lookup. Subname ownership + targetAddress changes are rare
 * (a user claims once and never again, or repoints during the vault
 * migration). A 5-minute TTL means the activity feed's per-counterparty
 * reverse-lookup (N counterparties × 4-page `listOwnedObjects` + a
 * SuinsClient.getNameRecord each) costs a few RPC round-trips only on
 * the cold first request, then nothing for the next 5 minutes.
 *
 * The cache lives at module scope and is keyed by lowercased address -
 * Sui addresses are case-insensitive on the wire but callers normalize
 * inconsistently; lowering here keeps hit-rate high.
 */
const SUBNAME_CACHE_TTL_MS = 5 * 60_000;

export async function findTaliseSubnameForOwner(
  owner: string
): Promise<OwnedSubname | null> {
  return memoTtl(
    `talise-subname:${owner.toLowerCase()}`,
    SUBNAME_CACHE_TTL_MS,
    () => _findTaliseSubnameForOwnerUncached(owner)
  );
}

async function _findTaliseSubnameForOwnerUncached(
  owner: string
): Promise<OwnedSubname | null> {
  // We do TWO passes: first collect every `*.talise.sui` SubDomain NFT
  // the user owns, then verify each via SuinsClient.getNameRecord and
  // only surface one whose targetAddress is set.
  //
  // Why: early mints (and any mint where `setTargetAddress` failed) leave
  // a SubDomainRegistration NFT in the wallet with a null SuiNS target.
  // The previous version returned the *first owned* NFT regardless of
  // whether the name actually resolved on chain, which made Home show
  // "alice@talise.sui" but Send return "couldn't find" for the same
  // name. We refuse to surface broken handles so Home shows the
  // "Claim your name" CTA and the user can re-claim cleanly.
  const owned: OwnedSubname[] = [];
  const client = sui();
  try {
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const r: Awaited<
        ReturnType<typeof client.listOwnedObjects<{ display: true }>>
      > = await client.listOwnedObjects({
        owner,
        limit: 50,
        cursor,
        include: { display: true },
      });
      for (const o of r.objects ?? []) {
        const t = o.type ?? "";
        // Subdomain NFTs are the only SuiNS objects that resolve via
        // SubDomainRegistration; the main suins_registration is the parent.
        if (!/subdomain_registration::SubDomainRegistration/.test(t)) continue;
        const name = readDisplayName(o.display);
        if (!name.endsWith(PARENT_SUFFIX)) continue;
        owned.push({
          username: name.slice(0, -PARENT_SUFFIX.length),
          fullName: name,
          nftId: o.objectId ?? "",
        });
      }

      if (!r.cursor) break;
      cursor = r.cursor;
    }
  } catch {
    return null;
  }

  if (owned.length === 0) return null;

  // Pass 2: verify each name actually resolves on chain. The first one
  // whose SuiNS NameRecord has a non-null targetAddress wins. If every
  // owned NFT has a null target (early mints, partial mints), we return
  // null so the UI prompts the user to claim a new one rather than
  // surfacing a name Send can't resolve.
  try {
    const { SuinsClient } = await import("@mysten/suins");
    const suins = new SuinsClient({
      client: client as never,
      network: "mainnet",
    });
    for (const cand of owned) {
      try {
        const rec = await suins.getNameRecord(cand.fullName);
        if (rec?.targetAddress) return cand;
      } catch {
        // "Object does not exist" / RPC hiccup, keep trying others.
      }
    }
  } catch {
    // SuinsClient init failed (rare), be conservative and report none
    // rather than risk surfacing a non-resolvable handle.
  }
  return null;
}
