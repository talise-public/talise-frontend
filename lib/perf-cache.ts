type Entry<T> = { value: T; expiresAt: number };

const store = new Map<string, Entry<unknown>>();

/**
 * Tiny in-memory TTL cache for server-side hot-path values like
 * `onara.status()` and `getReferenceGasPrice()`. Lives for the lifetime
 * of the Node process, Next.js Node runtime keeps modules alive across
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
// grepping Vercel logs. Bounded to 64 entries, enough to spot a
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

// The PENDING-ROUNDUP STASH used to live here: `sponsor-prepare` wrote the
// round-up amount for a user and `gasless-submit` read it back after the
// broadcast to enqueue into `roundup_queue`. Spend + Save is one atomic PTB
// now, so the amount never has to survive between two requests: it is inside
// the transaction the user signed. Removed along with the queue and its cron.

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
