type Entry<T> = { value: T; expiresAt: number };

const store = new Map<string, Entry<unknown>>();

/**
 * Tiny in-memory TTL cache for server-side hot-path values like
 * `onara.status()` and `getReferenceGasPrice()`. Lives for the lifetime
 * of the Node process — Next.js Node runtime keeps modules alive across
 * requests so this works in practice.
 *
 * Not safe for per-user secrets. Only use for values that are global
 * and cheap to refetch if the cache is wrong.
 */
export async function memoTtl<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await fetcher();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

export function invalidate(key: string) {
  store.delete(key);
}

// ───────────────────────────────────────────────────────────────────
// Send-latency ring buffer.
//
// In-process samples of the prepare + execute legs so an operator can
// hit `/api/health/send-latency` and see actual ms numbers without
// grepping Vercel logs. Bounded to 64 entries — enough to spot a
// regression, small enough that the buffer never matters for memory.
//
// Per-leg sample: `{ leg, totalMs, atMs, extras }`. `extras` carries
// the per-step breakdowns we already log (pk/roundup/navi for prepare,
// proof/onara for execute) so the dashboard can show a histogram per
// leg + a freshness-by-source breakdown for the proof.

export type SendLatencyLeg = "prepare" | "execute";

export type SendLatencySample = {
  leg: SendLatencyLeg;
  totalMs: number;
  atMs: number;
  extras?: Record<string, number | string | boolean | undefined>;
};

const SEND_LATENCY_MAX = 64;
const sendLatencyRing: SendLatencySample[] = [];

export function recordSendLatency(sample: SendLatencySample): void {
  sendLatencyRing.push(sample);
  if (sendLatencyRing.length > SEND_LATENCY_MAX) {
    sendLatencyRing.splice(0, sendLatencyRing.length - SEND_LATENCY_MAX);
  }
}

export function readSendLatencySamples(): SendLatencySample[] {
  // Return newest-first so the operator sees fresh data at the top of
  // the JSON response without paging.
  return sendLatencyRing.slice().reverse();
}

// ───────────────────────────────────────────────────────────────────
// Pending-roundup stash
//
// USDsui sends always take the gasless rail now, so the Spend-and-Save
// NAVI supply leg can't be co-bundled in the PTB. We bridge prepare ↔
// submit with a tiny per-user in-memory stash: `sponsor-prepare` writes
// `{ amountUsd, atMs }` for the user, `gasless-submit` reads + clears
// after the broadcast lands and enqueues into `roundup_queue`.
//
// Why in-memory and not the DB: this is a coupling between two
// requests in the same web process within seconds. A DB round-trip on
// the hot send path would undo the speed win we just bought. The
// 2-minute TTL is wide enough to cover even a slow prover + cold
// network, and short enough that a missed submit doesn't strand a
// roundup intent indefinitely.
//
// Safety net: if the stash misses (process restart between prepare and
// submit, or the user retries with a different bytes payload), the
// roundup is simply skipped for that send. The user's next send will
// re-trigger it. This is preferable to a half-applied save.

type PendingRoundup = { amountUsd: number; atMs: number };
const pendingRoundupByUser = new Map<number, PendingRoundup>();
const PENDING_ROUNDUP_TTL_MS = 120_000;

export function setPendingRoundup(userId: number, amountUsd: number): void {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    pendingRoundupByUser.delete(userId);
    return;
  }
  pendingRoundupByUser.set(userId, { amountUsd, atMs: Date.now() });
}

export function takePendingRoundup(userId: number): number | null {
  const hit = pendingRoundupByUser.get(userId);
  if (!hit) return null;
  pendingRoundupByUser.delete(userId);
  if (Date.now() - hit.atMs > PENDING_ROUNDUP_TTL_MS) return null;
  return hit.amountUsd;
}

// Pending inbound-settlement notification. Stashed by the SENDER's userId at
// sponsor-prepare (which knows the recipient + amount) and consumed at
// gasless-submit once the tx confirms, so we can notify the RECIPIENT. Same
// best-effort / same-instance / 2-min-TTL caveat as the roundup stash above:
// a missed stash just means no notification for that send, never a failure.
type PendingInbound = {
  to: string;
  amountUsd: number;
  senderName: string;
  atMs: number;
};
const pendingInboundByUser = new Map<number, PendingInbound>();
const PENDING_INBOUND_TTL_MS = 120_000;

export function setPendingInbound(
  userId: number,
  info: { to: string; amountUsd: number; senderName: string }
): void {
  if (!info.to || !Number.isFinite(info.amountUsd) || info.amountUsd <= 0) {
    pendingInboundByUser.delete(userId);
    return;
  }
  pendingInboundByUser.set(userId, { ...info, atMs: Date.now() });
}

export function takePendingInbound(
  userId: number
): { to: string; amountUsd: number; senderName: string } | null {
  const hit = pendingInboundByUser.get(userId);
  if (!hit) return null;
  pendingInboundByUser.delete(userId);
  if (Date.now() - hit.atMs > PENDING_INBOUND_TTL_MS) return null;
  return { to: hit.to, amountUsd: hit.amountUsd, senderName: hit.senderName };
}
