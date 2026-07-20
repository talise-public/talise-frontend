import "server-only";
import { MemWal } from "@mysten-incubation/memwal";

/**
 * Walrus Memory (Mysten's MemWal), hosted, persistent agent memory.
 *
 * Why a manual client (not the AI-SDK `withMemWal` middleware): that middleware
 * SAVES after the LLM call as fire-and-forget. In a Vercel serverless streaming
 * function the instance is frozen/killed once the response finishes, so the save
 * never lands and nothing persists across chats. Here we control both legs:
 *   • recall, awaited BEFORE the reply, injected into the prompt.
 *   • remember, awaited BEFORE the stream closes (the function stays alive while
 *     the stream is open), so the write to Walrus actually completes.
 *
 * Per-wallet namespace so memories never bleed between users. No DB. If the
 * account/key env is missing it silently no-ops. Set FEATURE_AGENT_MEMORY=false
 * to hard-disable.
 */

const SERVER_URL = process.env.MEMWAL_SERVER_URL?.trim() || "https://relayer.memwal.ai";
const ACCOUNT_ID = process.env.MEMWAL_ACCOUNT_ID?.trim() || "";
const DELEGATE_KEY = process.env.MEMWAL_DELEGATE_KEY?.trim() || "";
const DISABLED = process.env.FEATURE_AGENT_MEMORY?.trim().toLowerCase() === "false";

export function memwalConfigured(): boolean {
  return !DISABLED && Boolean(ACCOUNT_ID && DELEGATE_KEY);
}

/** Per-user isolation: one Talise account, a namespace per wallet address. */
function nsFor(address: string): string {
  return `talise:${address.toLowerCase()}`;
}

function clientFor(address: string): MemWal {
  return MemWal.create({
    accountId: ACCOUNT_ID,
    key: DELEGATE_KEY,
    serverUrl: SERVER_URL,
    namespace: nsFor(address),
  });
}

/**
 * Recalled memories are folded into the agent's system prompt, so treat their
 * text as untrusted: strip intent/memory control fences, control chars, and any
 * leading markdown heading/quote/bullet that could impersonate a prompt section.
 */
function sanitizeMemory(text: string): string {
  return (
    text
      // Strip intent/section fences (---INTENT---, ---END---, etc.).
      .replace(/---[A-Z_]{2,}---/g, " ")
      // Neutralize an intent-JSON shape (`{"steps":[…]}`) smuggled into a
      // memory, so it can never be echoed back and parsed as a real intent.
      // Precise enough to leave casual "steps:" prose alone.
      .replace(/\{\s*"?steps"?\s*:/gi, "{ blocked_steps:")
      // Control chars → space.
      .replace(/[\x00-\x1f]+/g, " ")
      // Strip markdown headings ANYWHERE (not just line-start): a mid-string
      // "## SYSTEM (verified)" must not impersonate a prompt section.
      .replace(/(^|\s)#{1,6}(?=\s)/g, " ")
      // Defang shouty authority cues (ALL-CAPS only, so normal prose is
      // untouched) that injected "memories" use to fake system directives.
      .replace(
        /\b(SYSTEM|DEVELOPER|DEVMODE|ADMIN|SECURITY|VERIFIED|POLICY|OVERRIDE|NOTICE|INSTRUCTIONS?|SUDO|ROOT)\b/g,
        (m) => m.toLowerCase(),
      )
      .replace(/\s+/g, " ")
      // Strip any leading markdown/quote/bullet that could open a fake section.
      .replace(/^[>#*\-\s]+/, "")
      .trim()
      .slice(0, 400)
  );
}

/** Recall the most relevant memories for this user's message. Never throws. */
export async function recallMemories(address: string, query: string, max = 6): Promise<string[]> {
  if (!memwalConfigured() || !query.trim()) return [];
  try {
    const r = await clientFor(address).recall(query.slice(0, 500));
    return (r.results ?? [])
      .slice()
      .sort((a, b) => a.distance - b.distance)
      .slice(0, max)
      .map((m) => (typeof m.text === "string" ? sanitizeMemory(m.text) : ""))
      .filter((t) => t.length > 0);
  } catch {
    return [];
  }
}

/**
 * Classify a caught write error as PERMANENT (never retry, give up now) or
 * TRANSIENT (a real blip, keep retrying with backoff).
 *
 * The memwal SDK surfaces server errors as `MemWal server error (503): {…body…}`,
 * so we parse the HTTP status and body out of the message string.
 *
 * PERMANENT:
 *   • the relayer's "writes paused for a security upgrade" message (a 503 that
 *     will NEVER clear on retry until Mysten lifts the pause), OR
 *   • any HTTP 4xx (auth / config / permanent server state).
 * TRANSIENT (default):
 *   • network errors, client/server timeouts, generic 5xx (incl. a plain 503
 *     WITHOUT the "paused" text), and the known Enoki gas blips
 *     ("could not determine a budget", "balance::destroy_zero").
 */
function classifyError(msg: string): "permanent" | "transient" {
  const lower = msg.toLowerCase();
  // The specific relayer pause is permanent even though it rides on a 503.
  if (lower.includes("paused") || lower.includes("security upgrade")) return "permanent";
  // Pull an HTTP status out of `MemWal server error (503): …` shapes.
  const statusMatch = msg.match(/\((\d{3})\)/);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  // 4xx = auth/config/permanent server states, retrying can't fix them.
  if (status >= 400 && status < 500) return "permanent";
  // Everything else (5xx, timeouts, network, gas blips) is worth retrying.
  return "transient";
}

/**
 * Circuit breaker: once we hit a permanent "writes paused" error, short-circuit
 * subsequent calls for this window so we don't hammer a relayer we know is down.
 * When the window expires we allow one probe again, so writes auto-recover the
 * moment Mysten lifts the pause. Module-level so it survives across warm
 * invocations of the same serverless instance.
 */
const PAUSE_COOLDOWN_MS = 10 * 60_000; // 10 minutes
let pausedUntil = 0;
let pausedLogged = false;

/**
 * Persist a memory to Walrus so a later chat can recall it. Runs in the route's
 * `after()` (background, off the user's critical path). Never throws.
 *
 * Resilience:
 *   • Permanent failures (relayer "writes paused for security upgrade", any 4xx)
 *     fast-fail immediately, no backoff, no further attempts.
 *   • A "writes paused" error also OPENS a lightweight circuit breaker: for a
 *     cooldown window, later calls short-circuit without even hitting the
 *     network (logged at most once per window). It auto-recovers by allowing one
 *     probe after the window, so writes resume once Mysten lifts the pause.
 *   • Only genuinely transient failures (network/timeout/generic 5xx, Enoki gas
 *     blips: "could not determine a budget / balance::destroy_zero") are retried
 *     with backoff (3s, 6s, 9s).
 */
export async function rememberFact(
  address: string,
  text: string,
  { attempts = 4, timeoutMs = 20_000 }: { attempts?: number; timeoutMs?: number } = {}
): Promise<void> {
  if (!memwalConfigured() || !text.trim()) {
    console.log("[memwal] save skipped (configured=%s, empty=%s)", memwalConfigured(), !text.trim());
    return;
  }
  // Circuit breaker open: writes are known-paused. Skip the network entirely
  // until the cooldown expires (logged once per window to avoid log spam).
  if (Date.now() < pausedUntil) {
    if (!pausedLogged) {
      console.warn(
        "[memwal] writes paused (circuit breaker open), skipping until %s",
        new Date(pausedUntil).toISOString(),
      );
      pausedLogged = true;
    }
    return;
  }
  const t = text.slice(0, 1500);
  const client = clientFor(address);
  const ns = address.toLowerCase();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const r = (await Promise.race([
        client.rememberAndWait(t, undefined, { timeoutMs }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("client timeout")), timeoutMs + 1_000)),
      ])) as { blob_id?: string } | undefined;
      console.log("[memwal] saved memory blob=%s attempt=%d ns=talise:%s", r?.blob_id ?? "(ok)", attempt, ns);
      return;
    } catch (e) {
      const msg = (e as Error).message?.slice(0, 200) ?? String(e);
      if (classifyError(msg) === "permanent") {
        console.warn("[memwal] writes unavailable (permanent), not retrying: %s", msg);
        // Trip the breaker only for the "paused" case so a stray 4xx on one
        // write doesn't blackhole every subsequent write.
        const lower = msg.toLowerCase();
        if (lower.includes("paused") || lower.includes("security upgrade")) {
          pausedUntil = Date.now() + PAUSE_COOLDOWN_MS;
          pausedLogged = false; // arm the one-shot "breaker open" log for this window
        }
        return;
      }
      console.warn("[memwal] save attempt %d/%d failed (transient): %s", attempt, attempts, msg);
      if (attempt < attempts) {
        // Backoff: 3s, 6s, 9s, long enough for a transient relayer blip to clear.
        await new Promise((r) => setTimeout(r, attempt * 3_000));
      }
    }
  }
  console.warn("[memwal] save gave up after %d attempts ns=talise:%s", attempts, ns);
}
