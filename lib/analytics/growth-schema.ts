import "server-only";

import { db, ensureSchema, schemaVersionGate } from "@/lib/db";

/**
 * Schema for the FIRST-PARTY product-analytics (growth) pipeline.
 *
 * Why first-party: Talise is a money app. Shipping a third-party analytics SDK
 * into the wallet would put a vendor's script on the same page as the signing
 * path and hand them a per-user behavioural stream we can't audit. Instead all
 * three clients (web, iOS, Android) POST to ONE endpoint we own
 * (`/api/events`) and land in Postgres tables we own. No new vendor, no new
 * dependency, no client-side third-party code.
 *
 * Five tables, all created here (never in web/lib/db.ts, which other agents
 * own). Self-bootstrapping + memoized once per process, gated by a
 * one-SELECT `schemaVersionGate` so a cold start doesn't replay the DDL.
 *
 *   • growth_events          — the append-only event log (the raw truth).
 *   • growth_daily_active    — (day, user, platform) rollup. DAU/WAU/MAU and
 *                              retention read THIS, never the event log, so a
 *                              dashboard query touches thousands of rows
 *                              instead of millions (the prod pool is small).
 *   • growth_user_firsts     — set-once per-user milestone timestamps
 *                              (signup/funded/first_send). Makes every
 *                              "time-to-X" and activation metric a single
 *                              indexed scan.
 *   • growth_attribution     — FIRST-TOUCH acquisition per anonymous id
 *                              (utm/referrer/invite), captured before there is
 *                              a user to attach it to.
 *   • growth_user_attribution— the same first touch, promoted onto the user id
 *                              once the anon id stitches to an account. This is
 *                              the "source column on the user" the product
 *                              never had, as a 1:1 side table so we don't
 *                              mutate `users` (owned elsewhere).
 *   • growth_invites         — one row per invite SENT, with its click and
 *                              signup outcome. This is the K-factor table.
 *
 * PRIVACY (deliberate exclusions, enforced by the ingest normalizer in
 * web/lib/analytics/growth-ingest.ts):
 *   • No email, name, handle, Sui address, phone, bank detail, or device id.
 *   • No IP address. `country` is the coarse edge geo header only.
 *   • No exact money amounts — only `amount_band` (bucketed). Exact amounts
 *     already live in the money tables, where they belong and are access
 *     controlled. `fee_usd` IS stored exactly, because that is OUR revenue,
 *     not the user's balance.
 *   • No referral code in plaintext — only `ref_code_hash`.
 *   • No full URLs or query strings — only `referrer_host` and a whitelisted
 *     `landing_path`.
 *   • No recipient identifiers, memos, notes, or chat content.
 */

// Bump whenever ANY DDL below changes.
const GROWTH_SCHEMA_VERSION = "2026-07-25.1";

let _ready: Promise<void> | null = null;

export function ensureGrowthSchema(): Promise<void> {
  if (_ready) return _ready;
  _ready = (async () => {
    await ensureSchema();
    const c = db();

    const gate = await schemaVersionGate(
      "growth_events_schema_version",
      GROWTH_SCHEMA_VERSION
    );
    if (gate.upToDate) return;

    // ── growth_events ───────────────────────────────────────────────────
    // Append-only. One row per emitted event. Every column is a dimension a
    // dashboard groups by; anything that isn't a known dimension goes into
    // `props` (a small, whitelisted JSONB bag) so we never need a migration
    // to add a new event.
    //
    // `day` is the UTC calendar day of `ts`, stored explicitly rather than
    // derived, so retention/cohort GROUP BYs are a plain index scan with no
    // per-row timestamp math.
    await c.execute(
      `CREATE TABLE IF NOT EXISTS growth_events (
        id            BIGSERIAL PRIMARY KEY,
        event         TEXT NOT NULL,
        ts            BIGINT NOT NULL,
        -- DEFAULTS ARE LOAD-BEARING (fixed 2026-07-25). These three are NOT
        -- NULL, and a second writer (lib/referral-events.ts) inserts only
        -- (event, user_id, props, ts) after feature-probing column names. With
        -- no defaults every one of its inserts raised a not-null violation,
        -- got swallowed by its own try/catch, and logged
        -- "[growth] <name> insert skipped" — so the ENTIRE invite funnel and
        -- K-factor existed only in console logs, never in the table. Defaults
        -- fix every partial writer at once instead of patching them one by one.
        received_at   BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT,
        day           DATE NOT NULL DEFAULT CURRENT_DATE,
        user_id       INTEGER,
        anon_id       TEXT,
        session_id    TEXT,
        platform      TEXT NOT NULL DEFAULT 'server',
        app_version   TEXT,
        country       TEXT,
        source        TEXT,
        medium        TEXT,
        campaign      TEXT,
        referrer_host TEXT,
        surface       TEXT,
        step          TEXT,
        status        TEXT,
        error_code    TEXT,
        amount_band   TEXT,
        currency      TEXT,
        corridor      TEXT,
        fee_usd       DOUBLE PRECISION,
        invite_id     TEXT,
        ref_code_hash TEXT,
        props         JSONB
      )`
    );
    // Backfill the defaults onto an ALREADY-CREATED table: the block above is
    // CREATE TABLE IF NOT EXISTS, so it is a no-op wherever growth_events
    // already exists — which is exactly where the swallowed not-null
    // violations are happening. Idempotent and additive.
    for (const alter of [
      `ALTER TABLE growth_events ALTER COLUMN received_at SET DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT`,
      `ALTER TABLE growth_events ALTER COLUMN day SET DEFAULT CURRENT_DATE`,
      `ALTER TABLE growth_events ALTER COLUMN platform SET DEFAULT 'server'`,
    ]) {
      try {
        await c.execute(alter);
      } catch {
        /* column shape already fine, or a concurrent pass won the race */
      }
    }
    await c.execute(
      `CREATE INDEX IF NOT EXISTS growth_events_event_day_idx
         ON growth_events (event, day)`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS growth_events_user_ts_idx
         ON growth_events (user_id, ts DESC) WHERE user_id IS NOT NULL`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS growth_events_anon_ts_idx
         ON growth_events (anon_id, ts DESC) WHERE anon_id IS NOT NULL`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS growth_events_invite_idx
         ON growth_events (invite_id) WHERE invite_id IS NOT NULL`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS growth_events_day_platform_idx
         ON growth_events (day, platform)`
    );

    // ── growth_daily_active ─────────────────────────────────────────────
    // The retention/DAU substrate: at most one row per (day, user, platform)
    // no matter how many `app_open`s land. Upserted from the ingest path.
    await c.execute(
      `CREATE TABLE IF NOT EXISTS growth_daily_active (
        day      DATE NOT NULL,
        user_id  INTEGER NOT NULL,
        platform TEXT NOT NULL,
        opens    INTEGER NOT NULL DEFAULT 1,
        first_at BIGINT NOT NULL,
        last_at  BIGINT NOT NULL,
        PRIMARY KEY (day, user_id, platform)
      )`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS growth_daily_active_user_idx
         ON growth_daily_active (user_id, day)`
    );

    // ── growth_user_firsts ──────────────────────────────────────────────
    // Set-once milestones. Every write is COALESCE(existing, new) so the
    // FIRST occurrence wins and replays are harmless — that is what makes
    // `funded` / `first_send` exactly-once even though three clients and the
    // server can all emit them.
    await c.execute(
      `CREATE TABLE IF NOT EXISTS growth_user_firsts (
        user_id                 INTEGER PRIMARY KEY,
        first_seen_at           BIGINT,
        first_platform          TEXT,
        signup_started_at       BIGINT,
        signup_completed_at     BIGINT,
        onboarding_completed_at BIGINT,
        handle_claimed_at       BIGINT,
        kyc_completed_at        BIGINT,
        funded_at               BIGINT,
        first_send_at           BIGINT,
        first_cashout_at        BIGINT,
        first_invite_sent_at    BIGINT,
        push_enabled_at         BIGINT,
        last_open_at            BIGINT
      )`
    );

    // ── growth_attribution (anonymous first touch) ──────────────────────
    // Written on the very first event from a browser/device, BEFORE there is
    // an account. `anon_id` is a random client-generated id — not a
    // fingerprint, not a device id.
    await c.execute(
      `CREATE TABLE IF NOT EXISTS growth_attribution (
        anon_id        TEXT PRIMARY KEY,
        user_id        INTEGER,
        source         TEXT,
        medium         TEXT,
        campaign       TEXT,
        content        TEXT,
        term           TEXT,
        referrer_host  TEXT,
        landing_path   TEXT,
        invite_id      TEXT,
        ref_code_hash  TEXT,
        platform       TEXT,
        country        TEXT,
        first_touch_at BIGINT NOT NULL,
        stitched_at    BIGINT
      )`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS growth_attribution_user_idx
         ON growth_attribution (user_id) WHERE user_id IS NOT NULL`
    );

    // ── growth_user_attribution (the user's acquisition source) ─────────
    // 1:1 with `users`, set-once. A dashboard joins this to `users` wherever
    // it wants "signups by channel" / "LTV by channel". Kept out of the
    // `users` table on purpose: that table is owned by web/lib/db.ts.
    await c.execute(
      `CREATE TABLE IF NOT EXISTS growth_user_attribution (
        user_id        INTEGER PRIMARY KEY,
        source         TEXT,
        medium         TEXT,
        campaign       TEXT,
        content        TEXT,
        term           TEXT,
        referrer_host  TEXT,
        landing_path   TEXT,
        invite_id      TEXT,
        ref_code_hash  TEXT,
        first_platform TEXT,
        country        TEXT,
        first_touch_at BIGINT,
        attributed_at  BIGINT NOT NULL
      )`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS growth_user_attribution_source_idx
         ON growth_user_attribution (source)`
    );

    // ── growth_invites ──────────────────────────────────────────────────
    // The K-factor table. One row per invite the user actually SENT (share
    // sheet completed / link copied), with its click + signup outcome folded
    // in. `invite_id` is an opaque client-minted id carried in the share link
    // (`?i=<invite_id>`), so a click can be tied back to the exact send
    // without ever storing the referral code in plaintext.
    await c.execute(
      `CREATE TABLE IF NOT EXISTS growth_invites (
        invite_id       TEXT PRIMARY KEY,
        inviter_user_id INTEGER,
        ref_code_hash   TEXT,
        channel         TEXT,
        platform        TEXT,
        created_at      BIGINT NOT NULL,
        first_click_at  BIGINT,
        click_count     INTEGER NOT NULL DEFAULT 0,
        signup_user_id  INTEGER,
        signup_at       BIGINT
      )`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS growth_invites_inviter_idx
         ON growth_invites (inviter_user_id, created_at DESC)`
    );
    await c.execute(
      `CREATE INDEX IF NOT EXISTS growth_invites_code_idx
         ON growth_invites (ref_code_hash) WHERE ref_code_hash IS NOT NULL`
    );

    await gate.stamp();
  })().catch((err) => {
    // Reset so a transient DDL error retries on the next call.
    _ready = null;
    throw err;
  });
  return _ready;
}
