/**
 * BROWSER EMITTER for the Talise growth pipeline.
 *
 * A ~150-line replacement for a third-party analytics SDK. No vendor, no
 * cookies, no fingerprinting, no third-party script on the page that signs
 * transactions.
 *
 * Behaviour:
 *   • Events are QUEUED and flushed as a batch (2s debounce, or immediately at
 *     `MAX_EVENTS_PER_BATCH`), so a burst of interactions costs one request.
 *   • The last flush of a page uses `navigator.sendBeacon` on `pagehide`, which
 *     survives navigation — otherwise the final events of every session are
 *     lost, and those are exactly the drop-off events we care about.
 *   • `anonId` is a random UUID in localStorage. It is NOT derived from
 *     anything about the device or the user. Clearing site data resets it.
 *   • `sessionId` is a random UUID that rotates after 30 idle minutes, which is
 *     what makes "one app_open per session" meaningful.
 *
 * Import `track()` from here anywhere in the web app to add a funnel event.
 */

import {
  MAX_EVENTS_PER_BATCH,
  type GrowthAttributionInput,
  type GrowthEventInput,
  type GrowthEventName,
  type GrowthStatus,
} from "@/lib/analytics/events";

const ENDPOINT = "/api/events";
const ANON_KEY = "talise.growth.anon";
const SESSION_KEY = "talise.growth.session";
const SESSION_AT_KEY = "talise.growth.sessionAt";
const FIRST_TOUCH_KEY = "talise.growth.firstTouch";
const FIRST_OPEN_KEY = "talise.growth.firstOpen";
const OPEN_SESSION_KEY = "talise.growth.openSession";
const SESSION_IDLE_MS = 30 * 60 * 1000;
const FLUSH_DEBOUNCE_MS = 2_000;

let queue: GrowthEventInput[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let listenersBound = false;

// ── Storage helpers (every access guarded: Safari private mode throws) ───────

function ls(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return ls()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    ls()?.setItem(key, value);
  } catch {
    /* storage unavailable — we degrade to per-request ids, never throw */
  }
}

function uuid(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

// ── Identity ────────────────────────────────────────────────────────────────

export function anonId(): string {
  let id = read(ANON_KEY);
  if (!id) {
    id = uuid();
    write(ANON_KEY, id);
  }
  return id;
}

/** Current session id, rotating after 30 idle minutes. */
export function sessionId(): string {
  const now = Date.now();
  const last = Number(read(SESSION_AT_KEY)) || 0;
  let id = read(SESSION_KEY);
  if (!id || now - last > SESSION_IDLE_MS) {
    id = uuid();
    write(SESSION_KEY, id);
  }
  write(SESSION_AT_KEY, String(now));
  return id;
}

/** True exactly once per browser — the install/first-visit signal. */
function claimFirstOpen(): boolean {
  if (read(FIRST_OPEN_KEY)) return false;
  write(FIRST_OPEN_KEY, String(Date.now()));
  return true;
}

/** True exactly once per browser — first touch may only be attributed once. */
function claimFirstTouch(): boolean {
  if (read(FIRST_TOUCH_KEY)) return false;
  write(FIRST_TOUCH_KEY, String(Date.now()));
  return true;
}

// ── Emit ────────────────────────────────────────────────────────────────────

export type TrackOptions = {
  surface?: string;
  step?: string;
  status?: GrowthStatus;
  errorCode?: string;
  /** MUST come from `amountBand()`. Raw amounts are rejected server-side. */
  amountBand?: string;
  currency?: string;
  corridor?: string;
  feeUsd?: number;
  inviteId?: string;
  attribution?: GrowthAttributionInput;
  props?: Record<string, unknown>;
  /** Skip the debounce (use for events that precede a navigation). */
  immediate?: boolean;
};

export function track(event: GrowthEventName, opts: TrackOptions = {}): void {
  if (typeof window === "undefined") return;
  try {
    queue.push({
      event,
      ts: Date.now(),
      anonId: anonId(),
      sessionId: sessionId(),
      platform: "web",
      surface: opts.surface,
      step: opts.step,
      status: opts.status,
      errorCode: opts.errorCode,
      amountBand: opts.amountBand,
      currency: opts.currency,
      corridor: opts.corridor,
      feeUsd: opts.feeUsd,
      inviteId: opts.inviteId,
      attribution: opts.attribution,
      props: opts.props,
    });
    bindListeners();
    if (opts.immediate || queue.length >= MAX_EVENTS_PER_BATCH) flush();
    else schedule();
  } catch {
    /* analytics never breaks the page */
  }
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, FLUSH_DEBOUNCE_MS);
}

export function flush(useBeacon = false): void {
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const body = JSON.stringify({
    anonId: anonId(),
    sessionId: sessionId(),
    platform: "web",
    events: batch,
  });
  try {
    // `sendBeacon` is the only transport that reliably survives a page
    // teardown, so the exit events (the drop-off signal) actually land.
    if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
      // Same-origin so the session cookie rides along and the server can
      // resolve the user id itself.
      credentials: "same-origin",
    }).catch(() => undefined);
  } catch {
    /* drop the sample rather than surface an error */
  }
}

function bindListeners(): void {
  if (listenersBound || typeof window === "undefined") return;
  listenersBound = true;
  window.addEventListener("pagehide", () => flush(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(true);
  });
}

// ── First-touch attribution ─────────────────────────────────────────────────

const UTM_KEYS = ["source", "medium", "campaign", "content", "term"] as const;

/**
 * Read UTM params + referrer off the CURRENT page.
 *
 * We deliberately extract only the five UTM fields, the referrer HOST (never
 * the full referrer URL, which can carry someone else's query string), and the
 * bare pathname. Nothing else from the URL is captured.
 */
export function readAttribution(): GrowthAttributionInput {
  const out: GrowthAttributionInput = {};
  try {
    const params = new URLSearchParams(window.location.search);
    for (const k of UTM_KEYS) {
      const v = params.get(`utm_${k}`);
      if (v) out[k] = v.slice(0, 96);
    }
    const ref = params.get("ref");
    if (ref) out.refCode = ref.slice(0, 32);
    const invite = params.get("i");
    if (invite) out.inviteId = invite.slice(0, 64);
    if (document.referrer) {
      try {
        out.referrerHost = new URL(document.referrer).host;
      } catch {
        /* unparseable referrer — omit rather than guess */
      }
    }
    out.landingPath = window.location.pathname.slice(0, 96);
  } catch {
    /* no window/URL — return whatever we have */
  }
  return out;
}

/**
 * Boot the browser pipeline. Idempotent per page load; called by
 * `<GrowthAnalytics />` in the root layout.
 *
 * Emits, in order:
 *   • `app_first_open` once per browser  → installs / new-visitor count
 *   • `first_touch`     once per browser → acquisition attribution
 *   • `invite_clicked`  whenever `?ref=`/`?i=` is present → invite CTR
 *   • `app_open`        once per 30-min session → DAU/WAU/MAU + retention
 */
export function bootGrowth(): void {
  if (typeof window === "undefined") return;
  const attribution = readAttribution();
  const hasInvite = Boolean(attribution.refCode || attribution.inviteId);

  if (claimFirstOpen()) {
    track("app_first_open", { surface: attribution.landingPath ?? "/" });
  }
  if (claimFirstTouch()) {
    track("first_touch", { attribution, surface: attribution.landingPath ?? "/" });
  }
  // An invite click is recorded on EVERY invite landing, not just the first —
  // click-through rate needs every click, and the ingest side folds them into
  // one counter row.
  if (hasInvite) {
    track("invite_clicked", { attribution, inviteId: attribution.inviteId });
  }

  // One app_open per session window. Re-entering a tab after 30 idle minutes
  // is a new session and a new open, which is the definition DAU needs.
  // A SINGLE key holds the session we already opened for, so localStorage
  // doesn't accumulate one key per session forever.
  const sid = sessionId();
  if (read(OPEN_SESSION_KEY) !== sid) {
    write(OPEN_SESSION_KEY, sid);
    track("app_open", { surface: window.location.pathname.slice(0, 96) });
  }
}
