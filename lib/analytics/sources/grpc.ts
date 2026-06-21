import { getRecentActivityWithMeta } from "@/lib/activity";
import type { IndexedTx } from "@/lib/analytics/types";

/**
 * Resolve the USD-stablecoin magnitude an activity entry moved (sent OR
 * received).
 *
 * `amountUsdsui` only carries USDsui. A USDC/USDT (or other USD-pegged)
 * transfer lands in `otherCoin` with `amountUsdsui: null` — so without this it
 * was silently dropped from volume (the "$None" received rows). We treat any
 * coin whose symbol contains "USD" as a 1:1 dollar stablecoin and convert its
 * raw u64 amount by its decimals. Non-stablecoin "other" coins (WAL, meme
 * coins, etc.) stay null — they aren't stablecoin volume.
 */
function entryAmountUsd(e: {
  amountUsdsui: number | null;
  otherCoin: { symbol: string; amount: string; decimals: number } | null;
}): number | null {
  if (e.amountUsdsui !== null && Number.isFinite(e.amountUsdsui)) {
    return Math.abs(e.amountUsdsui);
  }
  const oc = e.otherCoin;
  if (oc && oc.symbol.toUpperCase().includes("USD")) {
    const raw = Number(oc.amount);
    const dec = Number.isFinite(oc.decimals) ? oc.decimals : 6;
    if (Number.isFinite(raw)) {
      const v = raw / Math.pow(10, dec);
      if (Number.isFinite(v)) return Math.abs(v);
    }
  }
  return null;
}

/**
 * Index a single address's on-chain transaction history via the existing
 * gRPC / GraphQL activity pipeline.
 *
 * Reuses `getRecentActivityWithMeta` (limit 80, includeNonTalise) and maps each
 * `ActivityEntry` -> `IndexedTx` with `source: "grpc"`.
 *
 * Returns `null` when no data could be read (the call threw, or the tx-history
 * leg timed out — `complete: false` — and yielded zero entries), so the caller
 * can distinguish "no data read" from a genuine zero-activity address (which
 * returns `[]`). Never throws.
 */
export async function indexAddressViaGrpc(
  address: string
): Promise<IndexedTx[] | null> {
  let entries;
  let complete: boolean;
  try {
    const res = await getRecentActivityWithMeta(address, 80, {
      includeNonTalise: true,
    });
    entries = res.entries;
    complete = res.complete;
  } catch {
    // Hard failure — could not read the chain at all.
    return null;
  }

  // A partial read (timed out) that produced nothing is indistinguishable from
  // "no data" — signal that to the caller rather than reporting a false zero.
  if (!complete && entries.length === 0) {
    return null;
  }

  const txs: IndexedTx[] = entries.map((e) => ({
    digest: e.digest,
    ts: e.timestampMs,
    direction: e.direction,
    amountUsd: entryAmountUsd(e),
    counterparty: e.counterparty,
    counterpartyName: e.counterpartyName,
    source: "grpc",
  }));

  return txs;
}
