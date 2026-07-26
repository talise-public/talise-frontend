import "server-only";

import { after } from "next/server";
import { db } from "@/lib/db";
import { ensureGrowthSchema } from "@/lib/analytics/growth-schema";
import { ensureRevenueSchema } from "@/lib/analytics/growth-revenue";
import {
  AMOUNT_BANDS,
  FIRST_COLUMNS,
  GROWTH_PLATFORMS,
  MAX_EVENTS_PER_BATCH,
  MAX_PROP_KEYS,
  MAX_STRING_LEN,
  SERVER_DERIVED_EVENTS,
  isGrowthEvent,
  type GrowthEventInput,
  type GrowthEventName,
  type GrowthPlatform,
} from "@/lib/analytics/events";
import {
  normalizeAttribution,
  recordFirstTouch,
  stitchAnonToUser,
  type NormalizedAttribution,
} from "@/lib/analytics/growth-attribution";

/**
 * INGEST: turn a batch of client-reported events into rows, cheaply.
 *
 * Cost discipline (the prod Postgres pool is small — `max: 8` per instance):
 *
 *   • The whole batch is ONE multi-row INSERT, not N inserts. A 50-event
 *     batch costs one round-trip.
 *   • Rollups are folded to their distinct keys first, so `app_open` × 20 in a
 *     batch is one upsert, not twenty.
 *   • The expensive one-time work (anon→user stitch, signup derivation) is
 *     memoized per process so a warm instance pays it once per user, not once
 *     per request.
 *   • Everything runs AFTER the response (`after()`), so the client never
 *     waits on analytics and an analytics failure can never turn into a client
 *     error. Nothing here is on a money path, and nothing here throws to a
 *     caller — every write is individually try/caught.
 *
 * TRUST: the client controls the event name, the surface and the band. It does
 * NOT control the user id (resolved from the session/bearer), the country (edge
 * header), the receive time, or the two derived events (`signup_completed`,
 * `invite_signup`) — those come from `users` and from our own tables, so a
 * tampered client cannot inflate signup or K-factor.
 */

// ── Context resolved by the route ────────────────────────────────────────────

export type IngestContext = {
  /** Resolved from the session cookie or mobile bearer. Null when anonymous. */
  userId: number | null;
  /** Coarse edge geo. We never store the IP. */
  country: string | null;
  /** Server receive time, epoch ms. */
  receivedAt: number;
  /** Fallbacks applied when an individual event omits them. */
  anonId: string | null;
  sessionId: string | null;
  platform: GrowthPlatform;
  appVersion: string | null;
};

// ── Normalized row ───────────────────────────────────────────────────────────

type Row = {
  event: GrowthEventName;
  ts: number;
  day: string;
  userId: number | null;
  anonId: string | null;
  sessionId: string | null;
  platform: GrowthPlatform;
  appVersion: string | null;
  country: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  referrerHost: string | null;
  surface: string | null;
  step: string | null;
  status: string | null;
  errorCode: string | null;
  amountBand: string | null;
  currency: string | null;
  corridor: string | null;
  feeUsd: number | null;
  inviteId: string | null;
  refCodeHash: string | null;
  props: string | null;
};

const PLATFORM_SET: ReadonlySet<string> = new Set(GROWTH_PLATFORMS);
const BAND_SET: ReadonlySet<string> = new Set(AMOUNT_BANDS);
const STATUS_SET: ReadonlySet<string> = new Set(["started", "ok", "error", "cancelled"]);

/** Clock skew tolerance. A client clock can be wrong; a wrong `day` corrupts
 *  every cohort, so anything outside this window snaps to server time. */
const MAX_FUTURE_MS = 5 * 60 * 1000; // 5 min
const MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Control characters (incl. DEL) — stripped so nothing can smuggle newlines
 *  or terminal escapes into a column a dashboard renders. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Coarse identifier: letters, digits and a few separators only. Blocks a
 *  client from smuggling an email/address/URL through `surface` or `step`. */
const IDENT_RE = /^[A-Za-z0-9._:>/\- ]+$/;

function str(v: unknown, max = MAX_STRING_LEN): string | null {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return null;
  const s = v.replace(CONTROL_CHARS, " ").trim().slice(0, max);
  return s.length ? s : null;
}

function ident(v: unknown, max = MAX_STRING_LEN): string | null {
  const s = str(v, max);
  if (!s) return null;
  return IDENT_RE.test(s) && !s.includes("@") ? s : null;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Whitelist a `props` bag: at most `MAX_PROP_KEYS` keys, scalar values only,
 * short keys, clamped strings. Objects and arrays are dropped — nested data is
 * how PII sneaks into an analytics table.
 */
function normalizeProps(v: unknown): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (n >= MAX_PROP_KEYS) break;
    const key = ident(k, 32);
    if (!key) continue;
    if (typeof val === "boolean") out[key] = val;
    else if (typeof val === "number" && Number.isFinite(val)) out[key] = val;
    else {
      const s = str(val, 64);
      if (s == null) continue;
      out[key] = s;
    }
    n++;
  }
  return n ? JSON.stringify(out) : null;
}

/**
 * Normalize one client event into a storable row, or null to DROP it.
 * Dropping is silent and intentional: a bad/unknown event must never 400 a
 * client (they'd retry forever), it just doesn't get recorded.
 */
function normalize(
  e: GrowthEventInput,
  ctx: IngestContext
): { row: Row; attribution: NormalizedAttribution | null } | null {
  if (!e || typeof e !== "object") return null;
  if (!isGrowthEvent(e.event)) return null;
  // A client may not assert a derived event.
  if (SERVER_DERIVED_EVENTS.has(e.event)) return null;

  const rawTs = num(e.ts) ?? ctx.receivedAt;
  const ts =
    rawTs > ctx.receivedAt + MAX_FUTURE_MS || rawTs < ctx.receivedAt - MAX_PAST_MS
      ? ctx.receivedAt
      : Math.floor(rawTs);

  const platform =
    typeof e.platform === "string" && PLATFORM_SET.has(e.platform)
      ? (e.platform as GrowthPlatform)
      : ctx.platform;
  // `server` is reserved for server-derived rows — a client claiming it is
  // downgraded rather than trusted.
  const safePlatform: GrowthPlatform = platform === "server" ? ctx.platform : platform;

  const attribution = e.attribution ? normalizeAttribution(e.attribution) : null;

  const band = str(e.amountBand, 16);
  const fee = num(e.feeUsd);

  const row: Row = {
    event: e.event,
    ts,
    day: utcDay(ts),
    userId: ctx.userId,
    anonId: ident(e.anonId ?? ctx.anonId, 64),
    sessionId: ident(e.sessionId ?? ctx.sessionId, 64),
    platform: safePlatform === "server" ? "web" : safePlatform,
    appVersion: str(e.appVersion ?? ctx.appVersion, 32),
    country: ctx.country,
    source: attribution?.source ?? null,
    medium: attribution?.medium ?? null,
    campaign: attribution?.campaign ?? null,
    referrerHost: attribution?.referrerHost ?? null,
    surface: ident(e.surface),
    step: ident(e.step, 48),
    status: STATUS_SET.has(String(e.status)) ? String(e.status) : null,
    errorCode: ident(e.errorCode, 48),
    // Only a KNOWN band is accepted. This is what stops a client shipping an
    // exact amount in the amount field.
    amountBand: band && BAND_SET.has(band) ? band : null,
    currency: ident(e.currency, 8),
    corridor: ident(e.corridor, 16),
    // Fees are clamped to a sane range; a negative or absurd fee is dropped
    // rather than allowed to poison a revenue sum.
    feeUsd: fee != null && fee >= 0 && fee < 1_000_000 ? fee : null,
    inviteId: ident(e.inviteId ?? attribution?.inviteId, 64),
    refCodeHash: attribution?.refCodeHash ?? null,
    props: normalizeProps(e.props),
  };

  return { row, attribution };
}

// ── Per-process memos (bounded) ──────────────────────────────────────────────

const STITCHED = new Set<string>();
const SIGNUP_STAMPED = new Set<number>();
const MEMO_CAP = 5_000;

function memo<T>(set: Set<T>, key: T): boolean {
  if (set.has(key)) return true;
  if (set.size >= MEMO_CAP) set.clear();
  set.add(key);
  return false;
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Accept a batch. Returns immediately after scheduling the work with
 * `after()`, so the route can answer 204 without waiting on Postgres.
 *
 * Returns the count of events that passed normalization (for the route's
 * response body / logging only).
 */
export function ingestBatch(events: GrowthEventInput[], ctx: IngestContext): number {
  const list = Array.isArray(events) ? events.slice(0, MAX_EVENTS_PER_BATCH) : [];
  const normalized = list
    .map((e) => normalize(e, ctx))
    .filter((x): x is { row: Row; attribution: NormalizedAttribution | null } => x !== null);
  if (!normalized.length) return 0;

  runInBackground(async () => {
    await ensureGrowthSchema();
    // Activate the additive revenue schema (fee columns + the fee ledger) from
    // here rather than from a money path, because we are not allowed to edit
    // those and a column nobody creates is a column that never exists. Running
    // it POST-RESPONSE with its own lock_timeout means the ALTERs cannot delay
    // or block anything a user is waiting on. Guarded: revenue-schema trouble
    // must never cost us the growth events.
    await safe(() => ensureRevenueSchema());
    const rows = normalized.map((n) => n.row);

    // 1. First touch, before anything else, so a stitch in the same batch has
    //    a row to promote.
    const firstTouch = normalized.find(
      (n) => n.attribution && (n.row.event === "first_touch" || n.row.event === "invite_clicked")
    );
    if (firstTouch?.attribution && firstTouch.row.anonId) {
      await safe(() =>
        recordFirstTouch({
          anonId: firstTouch.row.anonId as string,
          attribution: firstTouch.attribution as NormalizedAttribution,
          platform: firstTouch.row.platform,
          country: ctx.country,
          now: ctx.receivedAt,
        })
      );
    }

    // 2. Derived events (server truth) are appended to the same INSERT so they
    //    cost nothing extra.
    const derived = await deriveEvents(rows, ctx);
    const all = rows.concat(derived);

    // 3. One multi-row INSERT for the whole batch.
    await safe(() => insertRows(all));

    // 4. Folded rollups.
    await safe(() => upsertDailyActive(all));
    await safe(() => upsertFirsts(all));
    await safe(() => upsertInvites(all, ctx));
  });

  return normalized.length;
}

/**
 * ONE-LINE server-side emitter for any route that wants to record an event
 * from server truth (e.g. a webhook confirming a deposit settled).
 *
 * Deliberately fire-and-forget and individually guarded: `emitGrowthEvent()`
 * can never throw into, slow down, or fail a money path. Call it and move on.
 *
 *   emitGrowthEvent("funded", { userId, amountBand: amountBand(usd) });
 */
export function emitGrowthEvent(
  event: GrowthEventName,
  opts: {
    userId?: number | null;
    surface?: string;
    step?: string;
    status?: "started" | "ok" | "error" | "cancelled";
    errorCode?: string;
    amountBand?: string;
    currency?: string;
    corridor?: string;
    feeUsd?: number;
    inviteId?: string;
    platform?: GrowthPlatform;
    props?: Record<string, unknown>;
  } = {}
): void {
  try {
    const ctx: IngestContext = {
      userId: opts.userId ?? null,
      country: null,
      receivedAt: Date.now(),
      anonId: null,
      sessionId: null,
      platform: opts.platform ?? "server",
      appVersion: null,
    };
    const now = ctx.receivedAt;
    const row: Row = {
      event,
      ts: now,
      day: utcDay(now),
      userId: ctx.userId,
      anonId: null,
      sessionId: null,
      platform: opts.platform ?? "server",
      appVersion: null,
      country: null,
      source: null,
      medium: null,
      campaign: null,
      referrerHost: null,
      surface: ident(opts.surface),
      step: ident(opts.step, 48),
      status: opts.status ?? null,
      errorCode: ident(opts.errorCode, 48),
      amountBand: opts.amountBand && BAND_SET.has(opts.amountBand) ? opts.amountBand : null,
      currency: ident(opts.currency, 8),
      corridor: ident(opts.corridor, 16),
      feeUsd: opts.feeUsd != null && opts.feeUsd >= 0 ? opts.feeUsd : null,
      inviteId: ident(opts.inviteId, 64),
      refCodeHash: null,
      props: normalizeProps(opts.props),
    };
    runInBackground(async () => {
      await ensureGrowthSchema();
      await safe(() => insertRows([row]));
      await safe(() => upsertDailyActive([row]));
      await safe(() => upsertFirsts([row]));
    });
  } catch {
    /* analytics must never surface an error to a caller */
  }
}

// ── Background + error containment ───────────────────────────────────────────

function runInBackground(fn: () => Promise<void>): void {
  const guarded = () =>
    fn().catch((e) =>
      console.warn(`[growth] ingest failed: ${(e as Error)?.message ?? e}`)
    );
  try {
    // Post-response on Vercel; falls back to a detached promise elsewhere
    // (mirrors lib/snapshots.ts refreshInBackground).
    after(guarded);
  } catch {
    void guarded();
  }
}

async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.warn(`[growth] write failed: ${(e as Error)?.message ?? e}`);
  }
}

// ── Writes ───────────────────────────────────────────────────────────────────

const COLUMNS = [
  "event",
  "ts",
  "received_at",
  "day",
  "user_id",
  "anon_id",
  "session_id",
  "platform",
  "app_version",
  "country",
  "source",
  "medium",
  "campaign",
  "referrer_host",
  "surface",
  "step",
  "status",
  "error_code",
  "amount_band",
  "currency",
  "corridor",
  "fee_usd",
  "invite_id",
  "ref_code_hash",
  "props",
] as const;

async function insertRows(rows: Row[]): Promise<void> {
  if (!rows.length) return;
  const args: unknown[] = [];
  const tuples: string[] = [];
  const receivedAt = Date.now();
  for (const r of rows) {
    // `day` is cast explicitly (we send 'YYYY-MM-DD') and `props` is a JSON
    // string cast to jsonb, so the libSQL-shaped `?` adapter stays untouched.
    tuples.push(
      "(?, ?, ?, ?::date, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)"
    );
    args.push(
      r.event,
      r.ts,
      receivedAt,
      r.day,
      r.userId,
      r.anonId,
      r.sessionId,
      r.platform,
      r.appVersion,
      r.country,
      r.source,
      r.medium,
      r.campaign,
      r.referrerHost,
      r.surface,
      r.step,
      r.status,
      r.errorCode,
      r.amountBand,
      r.currency,
      r.corridor,
      r.feeUsd,
      r.inviteId,
      r.refCodeHash,
      r.props
    );
  }
  await db().execute({
    sql: `INSERT INTO growth_events (${COLUMNS.join(", ")}) VALUES ${tuples.join(", ")}`,
    args,
  });
}

/**
 * Fold every `app_open` in the batch to its distinct (day, user, platform) and
 * upsert once per key. This table — not the event log — is what DAU/WAU/MAU
 * and retention queries read.
 */
async function upsertDailyActive(rows: Row[]): Promise<void> {
  const keyed = new Map<string, { day: string; userId: number; platform: string; first: number; last: number; n: number }>();
  for (const r of rows) {
    if (r.event !== "app_open" || r.userId == null) continue;
    const k = `${r.day}|${r.userId}|${r.platform}`;
    const cur = keyed.get(k);
    if (cur) {
      cur.first = Math.min(cur.first, r.ts);
      cur.last = Math.max(cur.last, r.ts);
      cur.n += 1;
    } else {
      keyed.set(k, { day: r.day, userId: r.userId, platform: r.platform, first: r.ts, last: r.ts, n: 1 });
    }
  }
  if (!keyed.size) return;
  const args: unknown[] = [];
  const tuples: string[] = [];
  for (const v of keyed.values()) {
    tuples.push("(?::date, ?, ?, ?, ?, ?)");
    args.push(v.day, v.userId, v.platform, v.n, v.first, v.last);
  }
  await db().execute({
    sql: `INSERT INTO growth_daily_active (day, user_id, platform, opens, first_at, last_at)
          VALUES ${tuples.join(", ")}
          ON CONFLICT (day, user_id, platform) DO UPDATE SET
            opens    = growth_daily_active.opens + EXCLUDED.opens,
            first_at = LEAST(growth_daily_active.first_at, EXCLUDED.first_at),
            last_at  = GREATEST(growth_daily_active.last_at, EXCLUDED.last_at)`,
    args,
  });
}

/**
 * Stamp set-once milestones. One statement per user in the batch (normally
 * exactly one). Every assignment is COALESCE(existing, new), which is what
 * makes `funded` and `first_send` exactly-once across three clients replaying
 * the same event — no client-side dedup required.
 */
async function upsertFirsts(rows: Row[]): Promise<void> {
  type Acc = { firstSeen: number; platform: string; lastOpen: number | null; cols: Map<string, number> };
  const byUser = new Map<number, Acc>();
  for (const r of rows) {
    if (r.userId == null) continue;
    let acc = byUser.get(r.userId);
    if (!acc) {
      acc = { firstSeen: r.ts, platform: r.platform, lastOpen: null, cols: new Map() };
      byUser.set(r.userId, acc);
    }
    acc.firstSeen = Math.min(acc.firstSeen, r.ts);
    if (r.event === "app_open") acc.lastOpen = Math.max(acc.lastOpen ?? 0, r.ts);
    const col = FIRST_COLUMNS[r.event];
    if (col) {
      const prev = acc.cols.get(col);
      acc.cols.set(col, prev == null ? r.ts : Math.min(prev, r.ts));
    }
  }
  if (!byUser.size) return;

  const c = db();
  for (const [userId, acc] of byUser) {
    // Column names come from the FIRST_COLUMNS whitelist in events.ts, never
    // from the wire — no dynamic identifier can originate with a client.
    const cols = ["user_id", "first_seen_at", "first_platform", "last_open_at", ...acc.cols.keys()];
    const args: unknown[] = [userId, acc.firstSeen, acc.platform, acc.lastOpen, ...acc.cols.values()];
    const updates = [
      "first_seen_at = LEAST(COALESCE(growth_user_firsts.first_seen_at, EXCLUDED.first_seen_at), EXCLUDED.first_seen_at)",
      "first_platform = COALESCE(growth_user_firsts.first_platform, EXCLUDED.first_platform)",
      // NULLIF(..., 0) so a batch with no app_open leaves the column NULL
      // rather than writing a meaningless epoch-0 timestamp.
      "last_open_at = NULLIF(GREATEST(COALESCE(growth_user_firsts.last_open_at, 0), COALESCE(EXCLUDED.last_open_at, 0)), 0)",
      ...[...acc.cols.keys()].map(
        (k) => `${k} = LEAST(COALESCE(growth_user_firsts.${k}, EXCLUDED.${k}), EXCLUDED.${k})`
      ),
    ];
    await c.execute({
      sql: `INSERT INTO growth_user_firsts (${cols.join(", ")})
            VALUES (${cols.map(() => "?").join(", ")})
            ON CONFLICT (user_id) DO UPDATE SET ${updates.join(", ")}`,
      args,
    });
  }
}

/**
 * Invite bookkeeping — the K-factor table.
 *   • `invite_sent`    → one row per invite actually shared.
 *   • `invite_clicked` → increments that row's click counter (or creates a
 *                        click-only row, so a click on a link shared before
 *                        this pipeline existed is still counted).
 */
async function upsertInvites(rows: Row[], ctx: IngestContext): Promise<void> {
  const c = db();
  for (const r of rows) {
    if (r.event === "invite_sent" && r.inviteId) {
      await c.execute({
        sql: `INSERT INTO growth_invites
                (invite_id, inviter_user_id, ref_code_hash, channel, platform, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (invite_id) DO UPDATE SET
                inviter_user_id = COALESCE(growth_invites.inviter_user_id, EXCLUDED.inviter_user_id),
                ref_code_hash   = COALESCE(growth_invites.ref_code_hash, EXCLUDED.ref_code_hash),
                channel         = COALESCE(growth_invites.channel, EXCLUDED.channel)`,
        args: [r.inviteId, r.userId, r.refCodeHash, r.surface ?? r.step, r.platform, r.ts],
      });
    } else if (r.event === "invite_clicked") {
      const inviteId = r.inviteId ?? (r.refCodeHash ? `code:${r.refCodeHash}` : null);
      if (!inviteId) continue;
      await c.execute({
        sql: `INSERT INTO growth_invites
                (invite_id, ref_code_hash, platform, created_at, first_click_at, click_count)
              VALUES (?, ?, ?, ?, ?, 1)
              ON CONFLICT (invite_id) DO UPDATE SET
                first_click_at = COALESCE(growth_invites.first_click_at, EXCLUDED.first_click_at),
                click_count    = growth_invites.click_count + 1,
                ref_code_hash  = COALESCE(growth_invites.ref_code_hash, EXCLUDED.ref_code_hash)`,
        args: [inviteId, r.refCodeHash, r.platform, ctx.receivedAt, r.ts],
      });
    }
  }
}

// ── Server-side derivations ──────────────────────────────────────────────────

/**
 * Events derived from data only the SERVER can see. One query, run at most once
 * per user per warm process.
 *
 *   • `signup_completed` — stamped at `users.created_at` (the truth) the first
 *     time we see any authenticated event from a user who hasn't been stamped.
 *     This also BACKFILLS every pre-existing account on its next `app_open`, so
 *     retention cohorts work for users who signed up before this pipeline
 *     existed. A client may never assert it.
 *   • `invite_signup` — that same signup, when the anon id's first touch (or
 *     `users.referred_by_user_id`) says an invite brought them. The K-factor
 *     numerator, taken from the referral system's ground truth rather than a
 *     client claim.
 *   • `first_send` — backfilled from `rewards_events` (`kind='send_earn'`,
 *     written by the money path on every send). This is what gives WEB and
 *     HISTORICAL users a first_send milestone even though no web call site
 *     emits one, so activation and time-to-first-send are complete rather than
 *     mobile-only. Served by the existing `idx_rewards_user_created`.
 *   • `funded` — backfilled from the durable on-chain ledger
 *     (`analytics_tx_ledger`, direction `received`). There is deliberately NO
 *     server-side credit anywhere on the funding path — a Bridge/card purchase
 *     mints straight to the user's own Sui address, and a friend paying them is
 *     just an inbound transfer — so no route can observe "money in". The
 *     earliest inbound row for the user's address IS the observation, and it
 *     covers every funding source at once instead of one provider. Served by
 *     `analytics_tx_ledger_addr_idx`.
 */
async function deriveEvents(rows: Row[], ctx: IngestContext): Promise<Row[]> {
  const userId = ctx.userId;
  if (userId == null) return [];
  const anchor = rows[0];
  if (!anchor) return [];

  const out: Row[] = [];
  const c = db();

  // Stitch the anon id to the user once per process per pair.
  let inviteId: string | null = null;
  let refCodeHash: string | null = null;
  const anonId = anchor.anonId;
  if (anonId && !memo(STITCHED, `${anonId}:${userId}`)) {
    const stitched = await stitchAnonToUser({
      anonId,
      userId,
      platform: anchor.platform,
      now: ctx.receivedAt,
    }).catch(() => null);
    inviteId = stitched?.inviteId ?? null;
    refCodeHash = stitched?.refCodeHash ?? null;
  }

  if (memo(SIGNUP_STAMPED, userId)) return out;

  const r = await c
    .execute({
      sql: `SELECT u.created_at            AS created_at,
                   u.sui_address           AS sui_address,
                   u.referred_by_user_id   AS referred_by,
                   f.signup_completed_at   AS stamped,
                   f.first_send_at         AS send_stamped,
                   f.funded_at             AS funded_stamped,
                   (SELECT MIN(re.created_at)
                      FROM rewards_events re
                     WHERE re.user_id = u.id
                       AND re.kind = 'send_earn') AS first_send_truth
              FROM users u
              LEFT JOIN growth_user_firsts f ON f.user_id = u.id
             WHERE u.id = ?`,
      args: [userId],
    })
    .catch(() => null);
  const row = r?.rows[0] as Record<string, unknown> | undefined;
  if (!row) return out;

  // Backfill `funded` from the on-chain ledger. Kept as its OWN guarded
  // statement rather than a subquery in the SELECT above, because
  // `analytics_tx_ledger` is created by the indexer's schema pass, not ours: a
  // database that has never run an indexer batch does not have that table, and
  // folding it into the query above would make one missing table take down the
  // signup + first_send derivations too. Only issued when the milestone is
  // still unstamped, so a funded user costs zero extra round trips.
  if (row.funded_stamped == null && typeof row.sui_address === "string" && row.sui_address) {
    const fundedTs = await c
      .execute({
        sql: `SELECT MIN(ts) AS first_in
                FROM analytics_tx_ledger
               WHERE address = ? AND direction = 'received'`,
        args: [row.sui_address],
      })
      .then((res) => {
        const v = (res.rows[0] as Record<string, unknown> | undefined)?.first_in;
        const n = v == null ? NaN : Number(v);
        return Number.isFinite(n) && n > 0 ? n : null;
      })
      .catch(() => null);
    if (fundedTs != null) {
      out.push({
        ...anchor,
        event: "funded",
        ts: fundedTs,
        day: utcDay(fundedTs),
        surface: null,
        step: null,
        status: "ok",
        errorCode: null,
        amountBand: null,
        currency: null,
        corridor: null,
        feeUsd: null,
        props: null,
      });
    }
  }

  // Backfill first_send from the money path's own record, independently of
  // whether the signup is already stamped.
  const sendTruth = row.first_send_truth == null ? null : Number(row.first_send_truth);
  if (row.send_stamped == null && sendTruth != null && Number.isFinite(sendTruth) && sendTruth > 0) {
    out.push({
      ...anchor,
      event: "first_send",
      ts: sendTruth,
      day: utcDay(sendTruth),
      surface: null,
      step: null,
      status: "ok",
      errorCode: null,
      amountBand: null,
      currency: null,
      corridor: null,
      feeUsd: null,
      props: null,
    });
  }

  if (row.stamped != null) return out; // signup already stamped in a prior process

  const createdAt = Number(row.created_at);
  const ts = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : ctx.receivedAt;
  const base: Row = {
    ...anchor,
    event: "signup_completed",
    ts,
    day: utcDay(ts),
    platform: anchor.platform,
    surface: null,
    step: null,
    status: "ok",
    errorCode: null,
    amountBand: null,
    currency: null,
    corridor: null,
    feeUsd: null,
    props: null,
  };
  out.push(base);

  const referredBy = row.referred_by == null ? null : Number(row.referred_by);
  const attributedToInvite = inviteId != null || refCodeHash != null || referredBy != null;
  if (attributedToInvite) {
    out.push({
      ...base,
      event: "invite_signup",
      inviteId,
      refCodeHash,
      props: referredBy != null ? JSON.stringify({ referred: true }) : null,
    });
    const key = inviteId ?? (refCodeHash ? `code:${refCodeHash}` : null);
    if (key) {
      await safe(() =>
        c.execute({
          sql: `UPDATE growth_invites
                   SET signup_user_id = COALESCE(signup_user_id, ?),
                       signup_at      = COALESCE(signup_at, ?)
                 WHERE invite_id = ?`,
          args: [userId, ts, key],
        })
      );
    }
  }

  return out;
}
