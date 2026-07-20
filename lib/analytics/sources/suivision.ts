/**
 * Analytics source, SuiVision / BlockVision (SECONDARY, ENV-GATED).
 *
 * This is a fallback / cross-check source for on-chain transaction indexing.
 * It is DORMANT unless the BlockVision API key is provided.
 *
 *   ENV VAR:  BLOCKVISION_API_KEY   (set on Vercel to enable this source)
 *
 * When the key is unset, suiVisionEnabled() returns false and
 * indexAddressViaSuiVision() returns null, the indexer then relies on the
 * primary gRPC source alone and the build is never affected.
 *
 * Endpoint (BlockVision Sui Mainnet "Retrieve Account Activity"):
 *   GET https://api.blockvision.org/v2/sui/account/activities
 *   Header:  x-api-key: <BLOCKVISION_API_KEY>
 *   Query:   address (required), cursor (optional), limit (1..50, default 20)
 *   Docs:    https://docs.blockvision.org/reference/retrieve-account-activity
 *
 * Response shape (relevant fields):
 *   { code, message, result: {
 *       data: [ {
 *         digest, timestampMs, type, status, sender, gasFee,
 *         coinChanges: [ { amount, coinAddress, symbol, decimal, logo } ],
 *         nftChanges: [...],
 *         interactAddresses: [ { address, type, name, logo } ],
 *       } ],
 *       nextPageCursor
 *   } }
 *
 * We page a bounded window (up to ~100 activities) and normalize each activity
 * to an IndexedTx (source:'suivision'). amountUsd is populated only when the
 * activity moved a stablecoin (USDC / USDsui / USDT); otherwise null.
 *
 * NEVER throws, any error (missing key, network, non-200, bad JSON) -> null.
 */

import type { IndexedTx } from "@/lib/analytics/types";

const BASE_URL = "https://api.blockvision.org/v2/sui/account/activities";
const PAGE_LIMIT = 50; // BlockVision max per page
const MAX_ACTIVITIES = 100; // bounded window per address
const MAX_PAGES = 4; // safety stop (PAGE_LIMIT * MAX_PAGES >= MAX_ACTIVITIES)
const FETCH_TIMEOUT_MS = 12_000;

/** Stablecoin symbols we treat as ≈ USD magnitude (case-insensitive). */
const STABLE_SYMBOLS = new Set(["USDC", "USDSUI", "USDT", "USDC.E", "WUSDC"]);

export function suiVisionEnabled(): boolean {
  return !!process.env.BLOCKVISION_API_KEY;
}

/** ---- Raw BlockVision response shapes (only the fields we read) ---- */
type BvCoinChange = {
  amount?: string | null;
  coinAddress?: string | null;
  symbol?: string | null;
  decimal?: string | number | null;
};
type BvInteractAddress = {
  address?: string | null;
  type?: string | null;
  name?: string | null;
};
type BvActivity = {
  digest?: string | null;
  timestampMs?: string | number | null;
  type?: string | null;
  status?: string | null;
  sender?: string | null;
  coinChanges?: BvCoinChange[] | null;
  interactAddresses?: BvInteractAddress[] | null;
};
type BvResponse = {
  code?: number;
  message?: string;
  result?: {
    data?: BvActivity[] | null;
    nextPageCursor?: string | null;
  } | null;
};

/**
 * Index an address via BlockVision. Returns the normalized txs, or null when
 * the source is disabled or any error occurs (so the caller can distinguish
 * "no data read" from "genuinely zero").
 */
export async function indexAddressViaSuiVision(
  address: string,
): Promise<IndexedTx[] | null> {
  const apiKey = process.env.BLOCKVISION_API_KEY;
  if (!apiKey) return null;
  if (!address || !address.startsWith("0x")) return null;

  try {
    const activities: BvActivity[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        address,
        limit: String(PAGE_LIMIT),
      });
      if (cursor) params.set("cursor", cursor);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(`${BASE_URL}?${params.toString()}`, {
          method: "GET",
          headers: { "x-api-key": apiKey, accept: "application/json" },
          signal: controller.signal,
          cache: "no-store",
        });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        // If we already gathered some data on earlier pages, keep it;
        // otherwise this was a hard failure -> null.
        return activities.length ? normalize(activities, address) : null;
      }

      const json = (await res.json()) as BvResponse;
      const data = json?.result?.data;
      if (Array.isArray(data) && data.length) activities.push(...data);

      cursor = json?.result?.nextPageCursor ?? null;
      if (!cursor || activities.length >= MAX_ACTIVITIES) break;
    }

    return normalize(activities, address);
  } catch {
    return null;
  }
}

/** Map BlockVision activities -> IndexedTx[], deduped by digest. */
function normalize(activities: BvActivity[], address: string): IndexedTx[] {
  const out: IndexedTx[] = [];
  const seen = new Set<string>();

  for (const a of activities) {
    const digest = typeof a?.digest === "string" ? a.digest : null;
    if (!digest || seen.has(digest)) continue;
    seen.add(digest);

    const ts = toMs(a?.timestampMs);
    if (ts == null) continue;

    const amountUsd = stableAmountUsd(a?.coinChanges);
    const { counterparty, counterpartyName } = pickCounterparty(
      a?.interactAddresses,
      a?.sender,
      address,
    );

    out.push({
      digest,
      ts,
      direction: mapDirection(a?.type, a?.sender, address),
      amountUsd,
      counterparty,
      counterpartyName,
      source: "suivision",
    });
  }

  return out;
}

/** Parse BlockVision timestampMs (string|number ms) -> epoch ms, else null. */
function toMs(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/**
 * Sum the absolute USD magnitude of any stablecoin coin changes in the
 * activity. Returns null when no stablecoin moved (amount unknown in USD).
 */
function stableAmountUsd(changes: BvCoinChange[] | null | undefined): number | null {
  if (!Array.isArray(changes) || !changes.length) return null;
  let total = 0;
  let found = false;

  for (const c of changes) {
    const symbol = (c?.symbol ?? "").toUpperCase();
    if (!STABLE_SYMBOLS.has(symbol)) continue;
    const raw = Number(c?.amount);
    if (!Number.isFinite(raw) || raw === 0) continue;
    const decimals = decimalsOf(c?.decimal);
    total += Math.abs(raw) / Math.pow(10, decimals);
    found = true;
  }

  return found ? total : null;
}

/** Stablecoin decimals, default 6 (USDC/USDsui), clamp to a sane range. */
function decimalsOf(d: string | number | null | undefined): number {
  const n = typeof d === "number" ? d : Number(d);
  if (!Number.isFinite(n) || n < 0 || n > 18) return 6;
  return Math.round(n);
}

/**
 * Map a BlockVision activity `type` to our direction vocabulary
 * ('sent'|'received'|'swap'|'invest'|'withdraw'|'autoswap'). When the type is
 * a plain transfer, disambiguate sent vs received using the sender vs the
 * indexed address.
 */
function mapDirection(
  type: string | null | undefined,
  sender: string | null | undefined,
  address: string,
): string {
  const t = (type ?? "").toLowerCase();

  if (t.includes("swap")) return "swap";
  if (
    t.includes("stake") ||
    t.includes("deposit") ||
    t.includes("supply") ||
    t.includes("lend") ||
    t.includes("invest")
  ) {
    return "invest";
  }
  if (
    t.includes("unstake") ||
    t.includes("withdraw") ||
    t.includes("redeem") ||
    t.includes("claim")
  ) {
    return "withdraw";
  }

  // Transfer / send / receive: use sender to disambiguate.
  const isSender =
    typeof sender === "string" &&
    sender.toLowerCase() === address.toLowerCase();
  if (t.includes("receive")) return "received";
  if (t.includes("send") || t.includes("transfer")) {
    return isSender ? "sent" : "received";
  }

  // Fallback: sender of the activity = it left this address.
  return isSender ? "sent" : "received";
}

/**
 * Pick the most relevant counterparty from interactAddresses, skipping the
 * indexed address itself. Returns the address + resolved name (if any).
 */
function pickCounterparty(
  interact: BvInteractAddress[] | null | undefined,
  sender: string | null | undefined,
  address: string,
): { counterparty: string | null; counterpartyName: string | null } {
  if (!Array.isArray(interact) || !interact.length) {
    return { counterparty: null, counterpartyName: null };
  }

  const self = address.toLowerCase();
  // Prefer 'account' counterparties over packages; skip self.
  const accounts = interact.filter(
    (i) =>
      typeof i?.address === "string" &&
      i.address.toLowerCase() !== self &&
      (i?.type ?? "").toLowerCase() === "account",
  );
  const pool = accounts.length
    ? accounts
    : interact.filter(
        (i) =>
          typeof i?.address === "string" &&
          i.address.toLowerCase() !== self,
      );

  const pick = pool[0];
  if (!pick || typeof pick.address !== "string") {
    return { counterparty: null, counterpartyName: null };
  }
  const name =
    typeof pick.name === "string" && pick.name.trim() ? pick.name.trim() : null;
  return { counterparty: pick.address, counterpartyName: name };
}
