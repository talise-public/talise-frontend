import "server-only";

import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { GrowthAttributionInput, GrowthPlatform } from "@/lib/analytics/events";
import { MAX_STRING_LEN } from "@/lib/analytics/events";

/**
 * ACQUISITION ATTRIBUTION.
 *
 * Before this module Talise stored nothing about where a user came from: no
 * UTM capture, no referrer, no `source`. Every "which channel works" question
 * was unanswerable.
 *
 * The model is FIRST TOUCH, and it is deliberately two-staged because the
 * touch happens before the account exists:
 *
 *   1. First event from a browser/device → a row in `growth_attribution`
 *      keyed by the random `anon_id`. Written ONCE (ON CONFLICT DO NOTHING),
 *      so a later organic visit can never overwrite the paid/invite touch
 *      that actually acquired the user.
 *   2. The first AUTHENTICATED event from that same `anon_id` stitches it to
 *      the user id and promotes the touch into `growth_user_attribution`
 *      (user_id PK, set-once). That table is the "source on the user" the
 *      product was missing — as a 1:1 side table, because `users` is owned by
 *      web/lib/db.ts.
 *
 * What we deliberately DO NOT store: the full landing URL, the full referrer,
 * the query string, the IP, or the referral code in plaintext. Only the
 * referrer HOST, a whitelisted path, and sha256(code).
 */

// ── Referral-code hashing ────────────────────────────────────────────────────

/**
 * Salted sha256 of a referral code, truncated to 32 hex chars.
 *
 * The plaintext code is a shareable secret that identifies a specific user, so
 * it never lands in the analytics store. The hash is stable, which is all the
 * K-factor join needs (invite row and click row hash to the same value).
 *
 * The salt comes from an existing app secret so no new env var is required; if
 * none is set we fall back to an unsalted hash (still non-reversible for the
 * dashboard's purposes, and referral codes are short so we document that a
 * dictionary attack on the hash is possible — that is why the salt matters and
 * why we prefer it when present).
 */
export function hashRefCode(code: string | null | undefined): string | null {
  const raw = (code ?? "").trim().toUpperCase();
  if (!raw) return null;
  const salt =
    process.env.DB_ENCRYPTION_KEY ||
    process.env.AUTH_SECRET ||
    process.env.SESSION_SECRET ||
    "";
  return createHash("sha256").update(`${salt}|refcode|${raw}`).digest("hex").slice(0, 32);
}

// ── Channel classification ───────────────────────────────────────────────────

const SEARCH_HOSTS = ["google.", "bing.", "duckduckgo.", "yahoo.", "ecosia.", "brave."];
const SOCIAL_HOSTS = [
  "twitter.com",
  "x.com",
  "t.co",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "lnkd.in",
  "reddit.com",
  "tiktok.com",
  "youtube.com",
  "news.ycombinator.com",
  "warpcast.com",
  "farcaster",
];
const CHAT_HOSTS = ["t.me", "telegram", "whatsapp", "discord", "slack.com", "wa.me"];

/**
 * Collapse a first touch into ONE `source` value, the single dimension a
 * dashboard slices signups by. Precedence is deliberate:
 *
 *   invite  > utm_source > referrer class > "direct"
 *
 * An invite wins over UTM because if a user arrived on a friend's link, the
 * friend acquired them regardless of what campaign tag rode along.
 */
export function classifySource(a: GrowthAttributionInput): string {
  if (a.refCode || a.inviteId) return "invite";
  const utm = clean(a.source);
  if (utm) return utm.toLowerCase();
  const host = clean(a.referrerHost)?.toLowerCase();
  if (!host) return "direct";
  if (host.endsWith("talise.io") || host === "talise.io") return "internal";
  if (SEARCH_HOSTS.some((h) => host.includes(h))) return "search";
  if (SOCIAL_HOSTS.some((h) => host.includes(h))) return "social";
  if (CHAT_HOSTS.some((h) => host.includes(h))) return "chat";
  return "referral";
}

function clean(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, MAX_STRING_LEN);
  return s.length ? s : null;
}

/**
 * Reject anything that looks like a URL or carries a query string. Clients are
 * supposed to send a host and a bare path; this is the server-side guarantee
 * that a full URL (which can carry tokens, ids, or PII in the query) never
 * reaches the table even if a client regresses.
 */
function safeHost(v: string | null | undefined): string | null {
  const s = clean(v);
  if (!s) return null;
  const host = s.replace(/^https?:\/\//i, "").split("/")[0].split("?")[0].split("#")[0];
  return /^[a-z0-9.\-:]+$/i.test(host) ? host.toLowerCase() : null;
}

function safePath(v: string | null | undefined): string | null {
  const s = clean(v);
  if (!s) return null;
  const path = s.split("?")[0].split("#")[0];
  return /^\/[A-Za-z0-9/_\-.]*$/.test(path) ? path.slice(0, MAX_STRING_LEN) : null;
}

/** The normalized, storable form of a first touch. */
export type NormalizedAttribution = {
  source: string;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
  referrerHost: string | null;
  landingPath: string | null;
  inviteId: string | null;
  refCodeHash: string | null;
};

export function normalizeAttribution(a: GrowthAttributionInput): NormalizedAttribution {
  return {
    source: classifySource(a),
    medium: clean(a.medium),
    campaign: clean(a.campaign),
    content: clean(a.content),
    term: clean(a.term),
    referrerHost: safeHost(a.referrerHost),
    landingPath: safePath(a.landingPath),
    inviteId: clean(a.inviteId),
    refCodeHash: hashRefCode(a.refCode),
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Record the anonymous first touch. ON CONFLICT DO NOTHING is the whole point:
 * first touch means first, and a returning visitor must not rewrite it.
 */
export async function recordFirstTouch(opts: {
  anonId: string;
  attribution: NormalizedAttribution;
  platform: GrowthPlatform;
  country: string | null;
  now: number;
}): Promise<void> {
  await db().execute({
    sql: `INSERT INTO growth_attribution
            (anon_id, source, medium, campaign, content, term,
             referrer_host, landing_path, invite_id, ref_code_hash,
             platform, country, first_touch_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (anon_id) DO NOTHING`,
    args: [
      opts.anonId,
      opts.attribution.source,
      opts.attribution.medium,
      opts.attribution.campaign,
      opts.attribution.content,
      opts.attribution.term,
      opts.attribution.referrerHost,
      opts.attribution.landingPath,
      opts.attribution.inviteId,
      opts.attribution.refCodeHash,
      opts.platform,
      opts.country,
      opts.now,
    ],
  });
}

/**
 * Stitch an anon id to a user and promote its first touch onto the user.
 *
 * Returns the promoted row's invite coordinates so the caller can derive
 * `invite_signup` (the K-factor numerator) in the same pass.
 *
 * Both writes are set-once:
 *   • growth_attribution.user_id is filled only while still NULL, so one anon
 *     id belongs to the first account that used it.
 *   • growth_user_attribution is INSERT … DO NOTHING, so a second device
 *     signing into the same account never rewrites the acquiring channel.
 */
export async function stitchAnonToUser(opts: {
  anonId: string;
  userId: number;
  platform: GrowthPlatform;
  now: number;
}): Promise<{ inviteId: string | null; refCodeHash: string | null; source: string | null }> {
  const c = db();
  await c
    .execute({
      sql: `UPDATE growth_attribution
               SET user_id = ?, stitched_at = ?
             WHERE anon_id = ? AND user_id IS NULL`,
      args: [opts.userId, opts.now, opts.anonId],
    })
    .catch(() => undefined);

  const r = await c.execute({
    sql: `SELECT source, medium, campaign, content, term, referrer_host,
                 landing_path, invite_id, ref_code_hash, country, first_touch_at
            FROM growth_attribution
           WHERE anon_id = ?`,
    args: [opts.anonId],
  });
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return { inviteId: null, refCodeHash: null, source: null };

  await c
    .execute({
      sql: `INSERT INTO growth_user_attribution
              (user_id, source, medium, campaign, content, term,
               referrer_host, landing_path, invite_id, ref_code_hash,
               first_platform, country, first_touch_at, attributed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (user_id) DO NOTHING`,
      args: [
        opts.userId,
        row.source ?? null,
        row.medium ?? null,
        row.campaign ?? null,
        row.content ?? null,
        row.term ?? null,
        row.referrer_host ?? null,
        row.landing_path ?? null,
        row.invite_id ?? null,
        row.ref_code_hash ?? null,
        opts.platform,
        row.country ?? null,
        row.first_touch_at ?? null,
        opts.now,
      ],
    })
    .catch(() => undefined);

  return {
    inviteId: (row.invite_id as string | null) ?? null,
    refCodeHash: (row.ref_code_hash as string | null) ?? null,
    source: (row.source as string | null) ?? null,
  };
}
