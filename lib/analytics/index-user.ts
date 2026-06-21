/**
 * Per-user on-chain index pass.
 *
 * `indexUser(address)` runs the two analytics sources in parallel — the PRIMARY
 * gRPC / GraphQL activity pipeline and the SECONDARY (env-gated) BlockVision /
 * SuiVision REST source — then MERGES + DEDUPES the results by transaction
 * digest and computes a `UserIndex` aggregate for the address.
 *
 * Merge policy: gRPC is authoritative (richer Talise-resolved metadata), so when
 * the same digest appears in both sources we keep the gRPC entry and only fill in
 * fields that gRPC left null (amountUsd, counterparty, counterpartyName) from the
 * SuiVision entry. Digests seen only in SuiVision are added as-is.
 *
 * Resilient: each source returns null on a hard failure ("no data read") and `[]`
 * on a genuine zero-activity address; this function never throws — if both
 * sources yield no usable data the result is an all-zero `UserIndex` with an
 * empty `txs` array.
 */

import { indexAddressViaGrpc } from "@/lib/analytics/sources/grpc";
import { indexAddressViaSuiVision } from "@/lib/analytics/sources/suivision";
import type { IndexedTx, UserIndex } from "@/lib/analytics/types";

const EMPTY_INDEX: UserIndex = {
  txCount: 0,
  volumeUsd: 0,
  swapCount: 0,
  lastActiveAt: null,
  txs: [],
};

const SWAP_DIRECTIONS = new Set(["swap", "autoswap"]);

export async function indexUser(address: string): Promise<UserIndex> {
  // Run both sources in parallel; neither throws, but guard defensively so a
  // rejected promise can never bubble out of the index pass.
  const [grpcRes, suiVisionRes] = await Promise.all([
    indexAddressViaGrpc(address).catch(() => null),
    indexAddressViaSuiVision(address).catch(() => null),
  ]);

  const grpcTxs = grpcRes ?? [];
  const suiVisionTxs = suiVisionRes ?? [];

  if (grpcTxs.length === 0 && suiVisionTxs.length === 0) {
    // Either both sources failed (null) or both genuinely had no activity.
    return { ...EMPTY_INDEX, txs: [] };
  }

  // Merge keyed on digest. gRPC entries seed the map (authoritative); SuiVision
  // either fills gaps in an existing entry or contributes a brand-new digest.
  const byDigest = new Map<string, IndexedTx>();

  for (const tx of grpcTxs) {
    if (!tx.digest) continue;
    // First gRPC entry for a digest wins (sources should not emit dupes, but be
    // defensive against repeated digests within one source).
    if (!byDigest.has(tx.digest)) byDigest.set(tx.digest, tx);
  }

  for (const tx of suiVisionTxs) {
    if (!tx.digest) continue;
    const existing = byDigest.get(tx.digest);
    if (!existing) {
      byDigest.set(tx.digest, tx);
      continue;
    }
    // Fill only the fields gRPC left null; keep gRPC's authoritative fields.
    byDigest.set(tx.digest, {
      ...existing,
      amountUsd: existing.amountUsd ?? tx.amountUsd,
      counterparty: existing.counterparty ?? tx.counterparty,
      counterpartyName: existing.counterpartyName ?? tx.counterpartyName,
    });
  }

  const txs = Array.from(byDigest.values());

  let volumeUsd = 0;
  let swapCount = 0;
  let lastActiveAt: number | null = null;

  for (const tx of txs) {
    if (tx.amountUsd !== null && Number.isFinite(tx.amountUsd)) {
      volumeUsd += Math.abs(tx.amountUsd);
    }
    if (SWAP_DIRECTIONS.has(tx.direction)) swapCount += 1;
    if (
      typeof tx.ts === "number" &&
      Number.isFinite(tx.ts) &&
      (lastActiveAt === null || tx.ts > lastActiveAt)
    ) {
      lastActiveAt = tx.ts;
    }
  }

  return {
    txCount: txs.length,
    volumeUsd,
    swapCount,
    lastActiveAt,
    txs,
  };
}
