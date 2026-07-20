/**
 * Rate limiter with two backends: a global Upstash-Redis fixed-window
 * counter (preferred) and an in-process Map fallback.
 *
 * --- Why two backends ---
 * The in-memory Map is per-instance: on Vercel's multi-lambda fan-out the
 * effective cap is N× the configured limit (one bucket per warm instance,
 * reset on every cold start). That's "abuse mitigation", not a real quota
 * (audit finding F3). When `UPSTASH_REDIS_REST_URL` +
 * `UPSTASH_REDIS_REST_TOKEN` are set, `rateLimitAsync` instead does an
 * atomic `INCR` (+ `EXPIRE` on first hit) against Upstash over its REST
 * API, so the cap is GLOBAL across every instance and region.
 *
 * No SDK dependency: Upstash exposes a plain HTTPS REST endpoint that maps
 * 1:1 to Redis commands, so we hit it with `fetch`. Keeps the bundle lean.
 *
 * --- Failure modes (documented) ---
 *   - Env vars UNSET (local dev, preview without Redis): silently fall
 *     back to the in-memory Map. Logged once at first use.
 *   - Env vars set but Redis errors/times out: FAIL OPEN (allow the
 *     request) and log. A waitlist signup must never 500 because Redis
 *     hiccuped; the limiter is a guard, not a gate.
 *
 * --- Public API ---
 *   - `rateLimitAsync(opts)` → Promise<RateLimitResult>: Redis when
 *     configured, else in-memory. Use this for new/migrated callers.
 *   - `rateLimit(opts)` → RateLimitResult: synchronous in-memory only,
 *     kept for any caller that hasn't migrated. Identical shape.
 *   - `getClientIp(req)`: unchanged (already hardened, do not touch).
 *
 * --- TODO: extend Redis limiter to these routes next (P1 backlog) ---
 *   - /api/zk/sponsor                (sponsor request before execute)
 *   - /api/send/prepare              (PTB build is expensive)
 *   - /api/onramp/quote
 *   - /api/onramp/create-session
 *   - /api/offramp/quote
 *   - /api/username/claim            (handle squatting defense)
 *   - /api/auth/callback             (web OAuth landing)
 *   - /api/contacts/lookup           (PII enumeration vector)
 */

type Bucket = { count: number; resetAt: number };

// Module-level Map survives across requests within a single Node process.
// Vercel's per-function isolation means each lambda instance has its own
// copy, fine for abuse control, not for strict global quotas.
const buckets = new Map<string, Bucket>();

// Lazy GC: every N inserts we sweep expired keys so the Map doesn't grow
// unbounded under a long-running process (Vercel typically recycles
// instances often enough that this is mostly defensive).
let opsSinceSweep = 0;
const SWEEP_EVERY = 500;

function sweep(now: number): void {
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}

export interface RateLimitOptions {
  /** Caller-supplied key, typically `${routeId}:${ip}` or `${routeId}:user:${id}`. */
  key: string;
  /** Max requests permitted per window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** Seconds the client should wait before retrying. Only present when ok=false. */
  retryAfterSec?: number;
}

/**
 * Fixed-window rate limit check. Increments the counter for `key` and
 * returns whether the caller is within `limit` in the current window.
 *
 * Why fixed-window and not sliding-window: simpler, atomic in a single
 * process, and the burst behavior at window edges is fine for the
 * limits we care about (5-30 req per minute/hour).
 */
export function rateLimit(opts: RateLimitOptions): RateLimitResult {
  const { key, limit, windowSec } = opts;
  const now = Date.now();
  const windowMs = windowSec * 1000;

  if (++opsSinceSweep >= SWEEP_EVERY) {
    opsSinceSweep = 0;
    sweep(now);
  }

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }

  existing.count += 1;
  if (existing.count <= limit) {
    return { ok: true };
  }

  const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  return { ok: false, retryAfterSec };
}

// ── Upstash Redis backend ────────────────────────────────────────────

function upstashConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return { url, token };
  return null;
}

// Log the active mode exactly once so prod boot logs make it obvious
// whether caps are global (Redis) or per-instance (Map), the F3 signal.
let modeLogged = false;
function logModeOnce(redisEnabled: boolean): void {
  if (modeLogged) return;
  modeLogged = true;
  if (redisEnabled) {
    console.info("[rate-limit] backend=upstash-redis (global, cross-instance)");
  } else {
    console.warn(
      "[rate-limit] backend=in-memory (per-instance; set UPSTASH_REDIS_REST_URL + " +
        "UPSTASH_REDIS_REST_TOKEN for global caps, audit F3)"
    );
  }
}

/**
 * Run a Redis command via the Upstash REST API. Commands are sent as a
 * JSON array body (e.g. `["INCR", "rl:foo"]`) and the result comes back
 * as `{ result: <value> }`. Throws on transport/HTTP error so the caller
 * can decide its failure policy.
 */
async function upstashCmd(
  cfg: { url: string; token: string },
  command: (string | number)[]
): Promise<unknown> {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    // Never let a slow/dead Redis hang a request. AbortSignal.timeout is
    // available on Node 18+/Vercel runtime.
    signal: AbortSignal.timeout(1500),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`upstash ${command[0]} → HTTP ${res.status}`);
  }
  const json = (await res.json()) as { result?: unknown; error?: string };
  if (json.error) throw new Error(`upstash ${command[0]} → ${json.error}`);
  return json.result;
}

/**
 * Global fixed-window rate limit. Uses Upstash Redis when configured
 * (cap holds across every serverless instance/region); otherwise falls
 * back to the in-memory `rateLimit`.
 *
 * Redis algorithm (the standard Upstash primitive):
 *   1. `INCR rl:<key>` → current count in this window.
 *   2. If count === 1 (first hit), `EXPIRE rl:<key> windowSec` so the
 *      window self-resets. We don't pipeline; two round-trips on the
 *      first request per window is fine for our QPS.
 *   3. allow iff count <= limit. retryAfterSec derived from remaining TTL
 *      (best-effort: falls back to windowSec if TTL fetch is skipped).
 *
 * Failure policy: any Redis error → FAIL OPEN (return ok:true) + log.
 */
export async function rateLimitAsync(opts: RateLimitOptions): Promise<RateLimitResult> {
  const cfg = upstashConfig();
  logModeOnce(cfg !== null);

  if (!cfg) {
    // No Redis configured, preserve existing per-instance behavior.
    return rateLimit(opts);
  }

  const { key, limit, windowSec } = opts;
  const redisKey = `rl:${key}`;

  try {
    const raw = await upstashCmd(cfg, ["INCR", redisKey]);
    const count = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(count)) {
      throw new Error(`upstash INCR returned non-numeric: ${String(raw)}`);
    }

    if (count === 1) {
      // First request in this window, set the TTL. NX guards against a
      // race where another instance already set it (harmless either way).
      await upstashCmd(cfg, ["EXPIRE", redisKey, windowSec, "NX"]);
    }

    if (count <= limit) {
      return { ok: true };
    }

    // Over limit, best-effort remaining TTL for Retry-After. A failed
    // TTL fetch must not turn an over-limit denial into a 500, so default
    // to the full window.
    let retryAfterSec = windowSec;
    try {
      const ttl = await upstashCmd(cfg, ["TTL", redisKey]);
      const ttlNum = typeof ttl === "number" ? ttl : Number(ttl);
      if (Number.isFinite(ttlNum) && ttlNum > 0) retryAfterSec = ttlNum;
    } catch {
      /* keep windowSec default */
    }
    return { ok: false, retryAfterSec: Math.max(1, retryAfterSec) };
  } catch (err) {
    // FAIL OPEN: a Redis outage must not break the waitlist. Log and allow.
    console.error("[rate-limit] upstash error, failing open:", err);
    return { ok: true };
  }
}

/**
 * Best-effort client IP for rate-limit keying.
 *
 * Order matters for anti-spoofing: prefer the headers the PLATFORM sets
 * (and a client cannot forge) before the client-influenced
 * `x-forwarded-for`. On Vercel, `x-vercel-forwarded-for` and
 * `x-real-ip` are set by the edge to the true connecting IP and any
 * inbound value is overwritten, so they can't be spoofed. The leftmost
 * value of a raw `x-forwarded-for` IS attacker-controllable on
 * non-Vercel / self-hosted deploys (a client can send
 * `X-Forwarded-For: <anything>` to rotate their rate-limit bucket and
 * bypass every limiter), so it's the LAST resort. Falls back to a
 * literal so unknown clients still share one bucket rather than
 * skipping the check.
 *
 * AUDIT_PENDING(F3): these limits are still per-instance (in-memory Map).
 * Promote to Upstash Redis before scaling so caps are global, not N×.
 */
export function getClientIp(req: Request): string {
  // Vercel-set, non-spoofable.
  const vercel = req.headers.get("x-vercel-forwarded-for");
  if (vercel) {
    const first = vercel.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri.trim();
  // Client-influenced, last resort.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}
