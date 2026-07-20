import postgres, { type Sql } from "postgres";
import { createHash } from "node:crypto";
import { encryptAtRest, decryptAtRest } from "@/lib/crypto-at-rest";

/**
 * Talise database layer, Postgres.
 *
 * The application historically used libsql; this module preserves the
 * libsql-style API (`db().execute({sql, args})`, `db().batch([...], "write")`)
 * so the rest of the codebase didn't need to change during the migration.
 * Internally everything runs against Postgres via the `postgres` driver.
 *
 *   • `?` placeholders are auto-rewritten to `$1, $2, ...` at execute time
 *   • `execute()` returns `{ rows, rowsAffected }`, the shape callers expect
 *   • `batch()` runs the array of statements inside a single transaction
 *
 * Connection details come from `DATABASE_URL` (a standard
 * `postgres://USER:PASS@HOST:PORT/DB` URL). `DATABASE_AUTH_TOKEN` is ignored
 * for Postgres deployments; we keep the variable name in place so the libsql
 * fallback path can still be flipped on for local dev if needed later.
 */

/**
 * Table map (last updated 2026-05-29). One line each: what it stores +
 * primary writer. New tables: add a row here when you add to ensureSchema().
 *
 *   users               Canonical account row (zkLogin sub → Sui address,
 *                       profile, referral, points, vault id).
 *                       Primary writer: web/lib/db.ts (upsertUser).
 *
 *   tx_history          One row per on-chain tx surfaced in the activity
 *                       feed. Deduped by digest.
 *                       Primary writer: web/app/api/tx/record/route.ts.
 *
 *   invoices            Merchant-issued USDC invoices (B2C checkout).
 *                       Primary writer: web/app/api/invoices/route.ts.
 *
 *   rewards_events      Append-only ledger of points-awarding events
 *                       (referrals, sends, roundups, redemptions).
 *                       Primary writer: web/lib/rewards/earn.ts.
 *
 *   savings_goals       User-defined savings buckets w/ target + progress.
 *                       Primary writer: web/lib/rewards/goals.ts.
 *
 *   redemptions         Points-spending requests (gift cards, perks).
 *                       Primary writer: web/lib/rewards/redeem.ts.
 *
 *   waitlist            DEAD as of 2026-05-29. Original pre-launch email
 *                       capture; superseded by waitlist_signups. Kept so
 *                       prod rows are reachable for a future export.
 *                       Safe to drop in a P2 cleanup once exported.
 *
 *   waitlist_signups    Canonical waitlist + handle-claim. Email is PK;
 *                       claimed_handle reserves a *.talise.sui SuiNS name
 *                       bound to the user's wallet on first sign-in.
 *                       Primary writer: web/app/api/waitlist/route.ts +
 *                       web/lib/handle-claim.ts.
 *
 *   linq_offramps       Linq USDSUI → NGN bank payout orders.
 *                       Primary writer: web/app/api/offramp/linq/*.
 *
 *   kyc_upgrade_intents Append-only log of tier-upgrade requests + the
 *                       (mock) eKYC verdict. Never mutates users.kyc_tier.
 *                       Primary writer: web/app/api/kyc/route.ts.
 *                       Tier model: web/lib/kyc.ts; eKYC: web/lib/ekyc.ts.
 *
 *   transfers           Corridor-agnostic transfers state machine
 *                       (quoted → debited → onchain_settling →
 *                       onchain_settled → fiat_out_pending → settled,
 *                       + failed/refunded) across all corridors.
 *                       Primary writer: web/lib/transfers.ts.
 *
 *   float_pools         Per-corridor, per-currency, per-leg treasury
 *                       float inventory (fiat_in / fiat_out / usdc) with
 *                       a `segregated` safeguarding flag and reconcile
 *                       timestamp. Master plan §6. MODEL ONLY, no live
 *                       money moves through it yet.
 *                       Primary writer: web/lib/treasury.ts.
 *
 *   mobile_sessions     Opaque bearer tokens for the iOS client.
 *                       Created in lib/mobile-sessions.ts; CREATE TABLE
 *                       lives there too, this file only widens its int4
 *                       timestamp columns.
 *
 *   travel_rule_records FATF Travel Rule (master plan §7) audit log of
 *                       above-threshold transfer metadata: route, obligation,
 *                       IVMS-101 payload, Travel Rule network transfer id.
 *                       Primary writer: web/lib/travel-rule.ts
 *                       (recordTravelRuleTransfer). Schema only, NOT yet
 *                       wired into the send path.
 */

// ───────────────────────────────────────────────────────────────────
// Adapter, libsql-shaped API on top of postgres.js

type ExecuteArg = string | { sql: string; args?: ReadonlyArray<unknown> };

type ExecuteResult = {
  rows: Array<Record<string, unknown>>;
  rowsAffected: number;
};

type BatchStmt = { sql: string; args?: ReadonlyArray<unknown> };

interface DbAdapter {
  execute(arg: ExecuteArg): Promise<ExecuteResult>;
  batch(stmts: ReadonlyArray<BatchStmt>, mode?: "read" | "write"): Promise<ExecuteResult[]>;
}

// HMR-safe pool. Next.js dev re-evaluates this module on every edit; caching
// the postgres pool on globalThis makes each reload REUSE it instead of
// opening a fresh pool of `max` connections and orphaning the old one. Without
// this, repeated edits leak connections until the Postgres (PgBouncer) pooler
// saturates and every DB query hangs, which surfaces as /admin and any
// DB-backed route getting stuck on "Loading…". In production there is no HMR,
// so this is purely a dev-safety measure (the branch is a plain singleton).
const _pgGlobal = globalThis as unknown as { __talisePgPool?: Sql };
let _sql: Sql | null = _pgGlobal.__talisePgPool ?? null;
let _adapter: DbAdapter | null = null;
let _schemaReadyP: Promise<void> | null = null;

function getSql(): Sql {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Expected a Postgres connection string like " +
        "`postgres://user:pass@host:port/db`."
    );
  }
  _sql = postgres(url, {
    // Be permissive about TLS so the same code path works whether the host
    // has STARTTLS configured or not. Behaviour:
    //   • URL has `sslmode=disable`            → no TLS
    //   • URL has `sslmode=require`            → require TLS, no cert pinning
    //   • everything else (incl. no override)  → prefer TLS, fall back to plain
    // The pxxl Postgres docker image (`postgres:16-alpine`) doesn't enable
    // TLS by default on its public endpoint; forcing TLS there closes the
    // socket mid-handshake ("Client network socket disconnected before
    // secure TLS connection was established"). `prefer` avoids that.
    ssl: (() => {
      const mode = new URL(url).searchParams.get("sslmode");
      if (mode === "disable") return false;
      if (mode === "require") return { rejectUnauthorized: false };
      return "prefer";
    })(),
    // PgBouncer in TRANSACTION mode (Supabase pooled :6543) does not support
    // named prepared statements, postgres.js uses them by default, which
    // breaks with "prepared statement … does not exist" under the pooler.
    // Auto-disable when the URL is a transaction pooler; direct/session
    // connections keep prepared statements for speed.
    prepare: (() => {
      const u = new URL(url);
      if (u.searchParams.get("pgbouncer") === "true") return false;
      if (u.hostname.endsWith("pooler.supabase.com") && u.port === "6543") return false;
      return true;
    })(),
    // Modest per-instance pool, the platform pooler (PgBouncer) multiplexes
    // across lambdas, so each instance stays small while total concurrency
    // scales. Adjust if function concurrency rises.
    max: 8,
    idle_timeout: 30,
    connect_timeout: 10,
    // Recycle connections every 10 min. Without this, a long-lived process
    // (a `pnpm dev` server, a warm lambda) can hold a socket the serverless
    // Postgres pooler has silently dropped; reusing that dead socket makes
    // queries hang indefinitely (observed: the whole /admin board wedged on
    // "Loading…"). max_lifetime forces a fresh connect well before that bites.
    max_lifetime: 60 * 10,
    // Don't transform, keep snake_case column names exactly as queried.
    transform: { undefined: null },
    // Silence NOTICE chatter from idempotent migrations. CREATE TABLE
    // IF NOT EXISTS / ALTER TABLE ADD COLUMN IF NOT EXISTS each emit
    // a NOTICE on every cold start once the DB is migrated, useful
    // information once, pure log spam after that. Real warnings and
    // errors still propagate as exceptions on the query path.
    onnotice: () => {},
    // Parse BIGINT (oid 20) as a plain JS Number instead of postgres.js's
    // default (BigInt or string). Our BIGINT columns hold millisecond
    // timestamps (~1.78e12), well under Number.MAX_SAFE_INTEGER (9e15) -
    // and downstream code (`new Date(row.created_at).toISOString()`,
    // formatLocal(), etc.) treats them as numbers. Returning strings was
    // surfacing as "Invalid time value" on /api/rewards/insights and the
    // /earn snapshot.
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number | bigint | string) => String(x),
        parse: (x: string) => Number(x),
      },
    },
  });
  // Stash on globalThis so the next HMR reload reuses this exact pool.
  _pgGlobal.__talisePgPool = _sql;
  return _sql;
}

/**
 * Rewrite libsql-style `?` placeholders into `$1, $2, ...`. Quoted strings and
 * line/block comments are skipped so a literal `?` inside a string doesn't get
 * mistaken for a placeholder.
 */
function rewritePlaceholders(sql: string): string {
  let out = "";
  let i = 0;
  let n = 1;
  while (i < sql.length) {
    const ch = sql[i];
    // Single-quoted string, skip until the closing quote (handle doubled '').
    if (ch === "'") {
      out += ch;
      i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { out += sql[++i]; i++; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Double-quoted identifier, skip until closing.
    if (ch === '"') {
      out += ch;
      i++;
      while (i < sql.length && sql[i] !== '"') { out += sql[i++]; }
      if (i < sql.length) { out += sql[i++]; }
      continue;
    }
    // Line comment.
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") { out += sql[i++]; }
      continue;
    }
    // Block comment.
    if (ch === "/" && sql[i + 1] === "*") {
      out += sql[i++]; out += sql[i++];
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        out += sql[i++];
      }
      if (i < sql.length) { out += sql[i++]; out += sql[i++]; }
      continue;
    }
    if (ch === "?") {
      out += `$${n++}`;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function buildAdapter(): DbAdapter {
  if (_adapter) return _adapter;
  const sql = getSql();

  const runOn = async (
    runner: Sql,
    arg: ExecuteArg
  ): Promise<ExecuteResult> => {
    const raw = typeof arg === "string" ? arg : arg.sql;
    const args = typeof arg === "string" ? [] : (arg.args ?? []);
    const rewritten = rewritePlaceholders(raw);
    // `postgres`'s `unsafe()` accepts a placeholder string + values array,
    // which is exactly what the libsql-style API gives us.
    // postgres.js's `unsafe()` types its parameter array as `ParameterOrJSON[]`;
    // libsql's adapter accepts `unknown[]`. The cast bridges the two.
    const result = await runner.unsafe(rewritten, args as never[]);
    const rows = Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
    const rowsAffected =
      (result as unknown as { count?: number }).count ?? rows.length;
    return { rows, rowsAffected };
  };

  _adapter = {
    execute: (arg) => runOn(sql, arg),
    batch: async (stmts, _mode) => {
      void _mode;
      // libsql's batch is implicitly transactional. Mirror that with
      // postgres.js's transaction helper.
      return sql.begin(async (tx) => {
        const out: ExecuteResult[] = [];
        for (const s of stmts) {
          out.push(await runOn(tx as unknown as Sql, s));
        }
        return out;
      });
    },
  };
  return _adapter;
}

export function db(): DbAdapter {
  return buildAdapter();
}

// ───────────────────────────────────────────────────────────────────
// Schema migrations, Postgres flavor

/**
 * Max time to wait for the (idempotent) schema-ensure before giving up.
 * Generous for the DDL itself, its real job is to bound a HANG: if the DB
 * connection is wedged, doEnsureSchema() never settles, and because the
 * promise is memoized below, EVERY caller of ensureSchema() (i.e. every
 * route) would hang forever until the process restarts. Racing a timeout
 * turns that permanent wedge into a transient error that retries on the
 * next request with a fresh connection.
 */
const SCHEMA_READY_TIMEOUT_MS = 15_000;

export function ensureSchema(): Promise<void> {
  if (_schemaReadyP) return _schemaReadyP;
  _schemaReadyP = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        doEnsureSchema(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `ensureSchema timed out after ${SCHEMA_READY_TIMEOUT_MS}ms, DB unreachable or connection stale`
                )
              ),
            SCHEMA_READY_TIMEOUT_MS
          );
        }),
      ]);
    } catch (err) {
      // Reset so the NEXT request retries from scratch (fresh connection)
      // instead of awaiting a forever-pending promise.
      _schemaReadyP = null;
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();
  return _schemaReadyP;
}

async function doEnsureSchema(): Promise<void> {
  const c = db();

  // The schema below is grouped into sections. Within each section:
  //   1. CREATE TABLE IF NOT EXISTS for every table the section owns.
  //   2. ALTER TABLE ADD COLUMN IF NOT EXISTS in chronological order
  //      (each ALTER is harmless on a fresh DB because the CREATE above
  //      already includes the column, they exist for old deployments).
  //   3. CREATE INDEX IF NOT EXISTS, scoped to this section's tables.
  //
  // Every statement is idempotent, ensureSchema() is called on every
  // cold start and from dbHealth() repeatedly.
  const stmts: string[] = [
    // ─── auth / users ────────────────────────────────────────────────
    // Canonical account row. One per Google sub. `sui_address` is the
    // user's zkLogin-derived address; `salt` is fetched from Shinami on
    // mainnet and never leaves the server in plaintext. Profile and
    // monetization columns (referral, points, vault id) are bolted on
    // via ALTER, see below.
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      google_sub TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      picture TEXT,
      sui_address TEXT UNIQUE NOT NULL,
      salt TEXT NOT NULL,
      country TEXT,
      created_at BIGINT NOT NULL,
      last_seen_at BIGINT NOT NULL,
      notified_at BIGINT,
      account_type TEXT,
      business_name TEXT,
      business_handle TEXT UNIQUE,
      business_industry TEXT,
      talise_username TEXT UNIQUE
    )`,
    // Account-type + business profile.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS business_name TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS business_handle TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS business_industry TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS interests TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_on_receive INTEGER`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS spot_bm_id TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS talise_username TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_registry_id TEXT`,
    // Avatar override, an NFT (or any image URL) the user picked as their
    // display picture; null falls back to the Google `picture`.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS pfp_url TEXT`,
    // Referral + points.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_user_id INTEGER`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_count INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS points_total INTEGER DEFAULT 0`,
    // Round-up + lifetime tallies.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS roundup_enabled INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS roundup_percentage INTEGER DEFAULT 2`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS lifetime_sent_usd DOUBLE PRECISION DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS lifetime_saved_usd DOUBLE PRECISION DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS roundup_saved_usd DOUBLE PRECISION DEFAULT 0`,
    // Goal vaults (Phase 4): links a savings goal to its on-chain GoalVault<USDsui>
    // object id. NULL = legacy DB tracking-envelope goal (funds in the user's
    // balance); set = funds segregated in an owner-owned on-chain vault.
    `ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS vault_object_id TEXT`,
    `ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS yield_on INTEGER NOT NULL DEFAULT 0`,
    // AUDIT_PENDING (2026-05-29): the autoswap system was archived to
    // `web/_archive/autoswap-2026-05-29/`. The columns below are
    // dormant, no active code path writes them, but we keep them in
    // the schema so historical `talise_vault_id` values are preserved
    // for any future re-activation or data migration. Do not drop
    // without a separate audit + backup of populated rows.
    //
    // AUDIT_PENDING (vault-collapse, 2026-05-29): once
    // `scripts/drain-vault-to-admin.mjs --execute` finishes pulling
    // every vault's bag balances back to the single admin wallet, the
    // follow-up schema migration should: (1) NULL every
    // `users.talise_vault_id`, (2) drop `talise_vault_subname_repointed`,
    // (3) drop any vault-only dependent tables / indexes. Do not drop
    // in this commit, the drain must complete on-chain first so we
    // retain one revert window.
    //
    // Original purpose: TaliseVault + AutoSwap Path-C. `talise_vault_id`
    // was the user's shared-object vault id, set after they signed the
    // `vault::create()` tx. The repointed flag tracked whether their
    // `@talise` SuiNS subname target had been moved from their plain
    // wallet address to the vault id.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS talise_vault_id TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS talise_vault_subname_repointed INTEGER DEFAULT 0`,
    // KYC tier (master plan §7 compliance). 0 = email-only receive (the
    // implicit default for every existing + new row); 1..3 unlock higher
    // send/corridor limits as the user clears progressively stronger
    // identity checks. The tier model + limit table live in lib/kyc.ts;
    // getUserTier() reads this column and treats NULL as 0. Default 0 so
    // fresh inserts (which don't set it) land at the floor tier.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_tier INTEGER DEFAULT 0`,
    // Account deletion (App Store Guideline 5.1.1(v)). Set by
    // markUserDeleted() when the user deletes their Talise account
    // in-app. PII columns are redacted at the same time; financial
    // records (tx_history / transfers / linq_offramps / KYC artifacts)
    // are retained for bookkeeping + AML record-keeping obligations.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at BIGINT`,
    // Indexes on hot read paths. UNIQUE constraints above already cover
    // google_sub / sui_address / business_handle / talise_username
    // lookups; these add coverage for the non-unique reads.
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at)`,
    // Unique on columns added via ALTER (CREATE TABLE can't mark them).
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_talise_username ON users(talise_username)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)`,

    // ─── tx history / activity feed ──────────────────────────────────
    // One row per on-chain tx we surface in the activity feed. Deduped
    // by digest (UNIQUE). Hot reads: `userTxs()` (by user_id, recent
    // first).
    `CREATE TABLE IF NOT EXISTS tx_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      digest TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL,
      amount TEXT,
      asset TEXT,
      recipient TEXT,
      memo TEXT,
      receipt_object_id TEXT,
      created_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tx_user ON tx_history(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tx_created ON tx_history(created_at DESC)`,
    // Composite covers `WHERE user_id = ? ORDER BY created_at DESC` -
    // the only shape `userTxs()` and the activity routes issue. Without
    // it Postgres falls back to idx_tx_user + a sort.
    `CREATE INDEX IF NOT EXISTS idx_tx_user_created ON tx_history(user_id, created_at DESC)`,

    // ─── invoices (merchant B2C checkout) ────────────────────────────
    `CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      business_user_id INTEGER NOT NULL REFERENCES users(id),
      slug TEXT UNIQUE NOT NULL,
      amount_usdc TEXT NOT NULL,
      reference TEXT,
      customer_email TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at BIGINT NOT NULL,
      paid_at BIGINT,
      paid_digest TEXT,
      paid_by_address TEXT
    )`,
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS receipt_object_id TEXT`,
    // P1-3: explicit audit trail of the verified on-chain digest that
    // closed each invoice.
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_digest TEXT`,
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_by_address TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_invoice_biz ON invoices(business_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_invoice_slug ON invoices(slug)`,

    // ─── rewards: events / goals / redemptions ───────────────────────
    // Append-only ledger of points-awarding events. UI reads "20 most
    // recent for this user".
    `CREATE TABLE IF NOT EXISTS rewards_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL,
      points INTEGER NOT NULL,
      metadata TEXT,
      created_at BIGINT NOT NULL
    )`,
    // User-defined savings buckets.
    `CREATE TABLE IF NOT EXISTS savings_goals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      target_usd DOUBLE PRECISION NOT NULL,
      current_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      deadline_ms BIGINT,
      color TEXT,
      created_at BIGINT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
    )`,
    // Points-spending requests.
    `CREATE TABLE IF NOT EXISTS redemptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      sku TEXT NOT NULL,
      points_spent INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      metadata TEXT,
      created_at BIGINT NOT NULL,
      fulfilled_at BIGINT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_rewards_user ON rewards_events(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_rewards_created ON rewards_events(created_at DESC)`,
    // Covers `SELECT … FROM rewards_events WHERE user_id = ? ORDER BY
    // created_at DESC LIMIT 20` (rewards summary).
    `CREATE INDEX IF NOT EXISTS idx_rewards_user_created ON rewards_events(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_goals_user ON savings_goals(user_id, archived)`,
    `CREATE INDEX IF NOT EXISTS idx_redemptions_user ON redemptions(user_id, created_at DESC)`,

    // ─── waitlist (legacy + canonical) ───────────────────────────────
    // DEAD as of 2026-05-29; superseded by `waitlist_signups` below.
    // No queries remain in web/app or web/lib (verified by grep). Kept
    // in ensureSchema() because pre-launch prod rows are still present -
    // safe to drop in a P2 cleanup once the export is taken.
    // AUDIT_PENDING: confirm zero new writes for 30 days, then DROP.
    `CREATE TABLE IF NOT EXISTS waitlist (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      created_at BIGINT NOT NULL,
      source TEXT,
      invited_at BIGINT
    )`,
    `ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS name TEXT`,
    `ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS country TEXT`,
    `ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS reason TEXT`,
    `ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS confirmation_sent_at BIGINT`,
    `ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS confirmation_message_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_waitlist_created ON waitlist(created_at DESC)`,

    // Canonical waitlist. Email is the natural PK so dup detection is a
    // one-line `ON CONFLICT (email) DO NOTHING RETURNING email` in the
    // API route. `ip` / `user_agent` are captured for light abuse
    // triage. `confirmation_sent` flips true only after the Resend send
    // returns ok within the 4s timeout window.
    `CREATE TABLE IF NOT EXISTS waitlist_signups (
      email TEXT PRIMARY KEY,
      created_at BIGINT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      confirmation_sent BOOLEAN NOT NULL DEFAULT false,
      confirmation_sent_at BIGINT
    )`,
    // Handle-claim columns, Strategy A (reserve-in-DB).
    // `suins-operator.ts` ships only `mintSubname()` (one PTB: mint +
    // set target + transfer to user). It does NOT have a "mint to
    // operator now, transfer later" helper, which would be needed for
    // Strategy B. So at claim time we reserve in DB; the actual
    // on-chain mint runs on first sign-in when we know the user's Sui
    // address, zero gas until users actually show up.
    `ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS claimed_handle TEXT`,
    `ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS handle_claimed_at BIGINT`,
    `ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS handle_object_id TEXT`,
    `ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS handle_bound_user_id TEXT`,
    `ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS handle_bound_at BIGINT`,
    `CREATE INDEX IF NOT EXISTS idx_waitlist_signups_created ON waitlist_signups(created_at DESC)`,
    // Partial-unique on `claimed_handle` so the index ignores the NULL
    // rows (most signups won't claim a handle) but enforces "one handle
    // per claim" the moment a non-NULL value is written.
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_waitlist_claimed_handle
       ON waitlist_signups (claimed_handle) WHERE claimed_handle IS NOT NULL`,

    // ─── transfers (corridor-agnostic state machine) ─────────────────
    // One row per cross-border / on-ramp / off-ramp / internal transfer.
    // A TTL-locked quote that walks
    //   quoted → debited → onchain_settling → onchain_settled →
    //   fiat_out_pending → settled  (+ failed/refunded)
    // with the on-chain leg as the commit point. A post-commit fiat-out
    // failure sets `parked_funds=TRUE` (funds parked, never lost) so a
    // compensating action can reconcile later. See web/lib/transfers.ts.
    // `metadata` is a JSON blob of per-corridor coordinates (bank, handle,
    // memo).
    `CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      state TEXT NOT NULL,
      source_currency TEXT NOT NULL,
      dest_currency TEXT NOT NULL,
      usdsui_amount NUMERIC NOT NULL,
      source_amount NUMERIC NOT NULL,
      dest_amount NUMERIC NOT NULL,
      fx_rate NUMERIC NOT NULL,
      onchain_digest TEXT,
      provider_reference TEXT,
      state_reason TEXT,
      parked_funds BOOLEAN NOT NULL DEFAULT FALSE,
      metadata TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      debited_at BIGINT,
      onchain_settled_at BIGINT,
      settled_at BIGINT,
      failed_at BIGINT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_transfers_user ON transfers(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_transfers_state ON transfers(state, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_transfers_parked ON transfers(parked_funds, created_at DESC) WHERE parked_funds = TRUE`,

    // ─── team / batch payouts ────────────────────────────────────────
    // One row per batch payout, paying many recipients USDsui in ONE
    // atomic Onara-sponsored PTB ("pay your whole team in one signature").
    // `status` walks 'prepared' (bytes built, awaiting client sign) →
    // 'broadcast' (digest landed). `total_usd` is the summed USDsui across
    // all legs; `recipient_count` mirrors the child-row count. The PTB is
    // all-or-nothing on chain, so a batch is never partially paid.
    `CREATE TABLE IF NOT EXISTS payout_batches (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      kind TEXT,
      total_usd DOUBLE PRECISION,
      recipient_count INT,
      status TEXT,
      digest TEXT,
      created_at BIGINT
    )`,
    // The team this batch paid (when it came from a saved team), lets the
    // activity feed label the row "Paid {team}" with a team icon instead of
    // naming one arbitrary recipient. NULL for ad-hoc (non-team) batches.
    `ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS team_name TEXT`,
    `ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS team_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_payout_batches_user ON payout_batches(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_payout_batches_digest ON payout_batches(digest)`,
    // Per-recipient legs of a batch. `resolved_address` is the SuiNS-resolved
    // 0x address the PTB actually pays; `input_handle` preserves what the user
    // typed (@alice / alice.talise.sui / 0x…) for audit. `idx` is the leg's
    // position within the batch (matches the PTB leg order).
    `CREATE TABLE IF NOT EXISTS payout_batch_recipients (
      id TEXT PRIMARY KEY,
      batch_id TEXT,
      resolved_address TEXT,
      input_handle TEXT,
      amount_usd DOUBLE PRECISION,
      label TEXT,
      idx INT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_payout_batch_recipients_batch ON payout_batch_recipients(batch_id)`,

    // ─── roundup_queue (deferred spend-and-save) ─────────────────────
    // When a USDsui send takes the gasless rail (the only USDsui rail
    // now, see sponsor-prepare/route.ts), the round-up NAVI supply
    // leg can NOT be bundled atomically (gasless PTBs are restricted
    // to a single `0x2::coin::send_funds<T>` move call). Instead the
    // submit endpoint enqueues a row here and a cron drains the queue,
    // executing the supply as a separate (sponsored) tx.
    //
    // `processed_at` is NULL while pending; the partial index
    // `idx_roundup_queue_pending` covers the cron's hot read of
    // `WHERE processed_at IS NULL ORDER BY created_at`.
    `CREATE TABLE IF NOT EXISTS roundup_queue (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      amount_usd DOUBLE PRECISION NOT NULL,
      created_at BIGINT NOT NULL,
      processed_at BIGINT,
      tx_digest TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_roundup_queue_pending
       ON roundup_queue(created_at) WHERE processed_at IS NULL`,

    // ─── device_token (APNs push registration) ──────────────────────
    // One row per device push token. `token` is UNIQUE so a re-register
    // (e.g. token rotation, or the same device under a new account)
    // upserts cleanly. Consumed by the inbound-settlement push leg in
    // lib/notify.ts via deviceTokensForUser().
    `CREATE TABLE IF NOT EXISTS device_token (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      platform TEXT NOT NULL DEFAULT 'ios',
      updated_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_device_token_user ON device_token(user_id)`,

    // ─── float_pools (treasury / corridor inventory) ─────────────────
    // Per-corridor, per-currency inventory balances for the treasury
    // float model (master plan §6). "instant" = pre-positioned float on
    // both legs of a directed corridor, drawn down on authorization and
    // reconciled async behind the user; the on-chain leg is the
    // net-settlement rail BETWEEN these pools.
    //
    // One row per (corridor, currency, leg). A pool tracks three
    // inventory buckets:
    //   • fiat_in_pool , fiat collected on the send (funding) leg
    //   • fiat_out_pool, fiat pre-positioned for the payout leg
    //   • usdc_pool    , native USDC inventory used for the on-chain
    //                      net-settlement hop between legs (master plan
    //                      §3: corridor inventory in native USDC, NOT
    //                      USDsui, caps de-peg exposure)
    //
    // `segregated` flags safeguarded CLIENT money. SG MAS MPI / JP FSA
    // safeguarding obligations mean client balances must be held in
    // segregated client-money accounts and, critically, CANNOT be
    // lent into NAVI (master plan §5/§6/§9). Only Talise's OWN operating
    // float (segregated=false) is NAVI-eligible. The treasury helper
    // `assertNotLendable()` enforces this invariant in code.
    //
    // `reconciled_at` is the wall-clock ms of the last reconciliation
    // pass; `needsRebalance()` reads it together with the inventory
    // buckets. Balances here are a MOCK model + invariants, not live
    // treasury ops, no real money moves through this table yet.
    //
    // Writers: web/lib/treasury.ts (recordInflow / recordOutflow /
    // getPoolState / needsRebalance). Mirrors the same idempotent
    // CREATE/ALTER/INDEX discipline as every other section here.
    `CREATE TABLE IF NOT EXISTS float_pools (
      id SERIAL PRIMARY KEY,
      corridor TEXT NOT NULL,
      currency TEXT NOT NULL,
      leg TEXT NOT NULL,
      fiat_in_pool NUMERIC NOT NULL DEFAULT 0,
      fiat_out_pool NUMERIC NOT NULL DEFAULT 0,
      usdc_pool NUMERIC NOT NULL DEFAULT 0,
      segregated BOOLEAN NOT NULL DEFAULT false,
      reconciled_at BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    // One canonical pool row per (corridor, currency, leg). The treasury
    // helpers upsert against this key, so it must be UNIQUE.
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_float_pools_key
       ON float_pools (corridor, currency, leg)`,
    // Hot read: "which pools are stale / under-funded?" scans by
    // reconciliation recency.
    `CREATE INDEX IF NOT EXISTS idx_float_pools_reconciled
       ON float_pools (reconciled_at)`,

    // ─── kyc_upgrade_intents (compliance §7 tier engine) ─────────────
    // Append-only log of "user asked to move up to tier N" events. One
    // row per POST /api/kyc. `ekyc_ref` is the opaque reference the
    // (mock) eKYC provider hands back; `ekyc_status` is the provider's
    // verdict at intent time (pending|approved|rejected). Recording an
    // intent NEVER mutates users.kyc_tier, promotion is a separate,
    // reviewed write (lib/kyc.ts setUserTier), so a self-service POST
    // can't grant itself a higher limit. The tier model lives in
    // lib/kyc.ts; the eKYC adapter in lib/ekyc.ts.
    `CREATE TABLE IF NOT EXISTS kyc_upgrade_intents (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      from_tier INTEGER NOT NULL,
      requested_tier INTEGER NOT NULL,
      ekyc_provider TEXT,
      ekyc_ref TEXT,
      ekyc_status TEXT,
      created_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_kyc_intents_user
       ON kyc_upgrade_intents(user_id, created_at DESC)`,

    // ─── onramp_kyc (provider-agnostic on-ramp KYC state) ────────────
    // Per-user on-ramp KYC, layered ON TOP OF users.kyc_tier (the send-gate).
    // Models the richer per-provider, per-country tier (none|lite|standard|
    // enhanced) the on-ramp flow needs without disturbing the send/limit tier.
    // Reconciled via the provider webhook (/api/onramp/v2/kyc-webhook). Mirror
    // of the standalone migration at migrations/2026-06-05-onramp-kyc.sql.
    `CREATE TABLE IF NOT EXISTS onramp_kyc (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      kyc_tier TEXT NOT NULL DEFAULT 'none'
        CHECK (kyc_tier IN ('none', 'lite', 'standard', 'enhanced')),
      provider TEXT,
      provider_customer_id TEXT,
      kyc_link_id TEXT,
      status TEXT NOT NULL DEFAULT 'unverified'
        CHECK (status IN ('unverified', 'pending', 'approved', 'rejected', 'expired')),
      country TEXT,
      daily_limit_cents BIGINT,
      monthly_limit_cents BIGINT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // Bridge KYC-Links id (link.id), the stable poll handle while the Bridge
    // customer_id is still null (it's null until the user starts KYC). Added
    // via ALTER so existing onramp_kyc rows pick it up too.
    `ALTER TABLE onramp_kyc ADD COLUMN IF NOT EXISTS kyc_link_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_onramp_kyc_provider_customer
       ON onramp_kyc (provider_customer_id)
       WHERE provider_customer_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_onramp_kyc_status
       ON onramp_kyc (status)`,

    // ─── linq_offramps (USDSUI → NGN bank payout via Linq) ───────────
    // Replaces paga_offramps. Linq hands back a deposit wallet it watches and
    // pays the bank itself, so there's no treasury/on-chain-verify/refund
    // state here, just the order record + its mirrored status. `id` is our
    // uuid (also the Linq idempotencyKey); `linq_order_id` is Linq's order id
    // (used by the webhook + status poll).
    `CREATE TABLE IF NOT EXISTS linq_offramps (
      id TEXT PRIMARY KEY,
      linq_order_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      amount_usdsui NUMERIC NOT NULL,
      amount_ngn NUMERIC NOT NULL,
      rate NUMERIC NOT NULL,
      bank_code TEXT NOT NULL,
      bank_account_number TEXT NOT NULL,
      bank_account_name TEXT,
      wallet_address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'initiated',
      status_reason TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_linq_offramps_user
       ON linq_offramps (user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_linq_offramps_order
       ON linq_offramps (linq_order_id)`,

    // ─── user_bank_accounts (linked NGN bank accounts, attested) ─────
    // Off-ramp Phase 2: a user links an NGN bank account to their Talise
    // @handle. We verify the account name via Linq (verifyBank) and the
    // user signs a deterministic personal-message consent string with
    // their zkLogin identity; that signature is stored as
    // `attestation_digest` (the on-chain identity attestation that the
    // user consented to the link). Phase 3 (Send "to bank" toggle) reads
    // this table via getLinkedBankAccounts() so sending to @them can
    // target the linked bank. `user_id` is TEXT (mirrors linq_offramps,
    // which stores String(userId)), the app id is numeric but we keep
    // the same column shape as the sibling off-ramp table.
    `CREATE TABLE IF NOT EXISTS user_bank_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      bank_code TEXT NOT NULL,
      account_number TEXT NOT NULL,
      account_name TEXT,
      attestation_digest TEXT,
      is_primary BOOLEAN NOT NULL DEFAULT false,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    // Off-ramp Phase 3: one account per user is the PRIMARY payout target -
    // the bank a sender hits when they choose "pay to their bank" against a
    // @handle. Additive ALTER for installs that pre-date the column; existing
    // rows default to false (no primary) until one is explicitly set.
    `ALTER TABLE user_bank_accounts ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false`,
    `CREATE INDEX IF NOT EXISTS idx_user_bank_accounts_user
       ON user_bank_accounts (user_id)`,
    // One row per (user, bank, account), re-linking the same account is
    // an idempotent UPSERT (refreshes name + attestation), never a dup.
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_bank_accounts
       ON user_bank_accounts (user_id, bank_code, account_number)`,

    // ─── travel_rule_records (FATF Travel Rule audit log) ────────────
    // Master plan §7: above the ~$1,000 Travel Rule threshold, external
    // transfers must exchange IVMS-101 originator/beneficiary data. This
    // table is the audit log of that compliance metadata, route
    // (INTERNAL / EXTERNAL_VASP / UNHOSTED), the obligation that applied,
    // the IVMS-101 payload (JSON), and the Travel Rule network transfer
    // id once a message has been submitted. Written by
    // `recordTravelRuleTransfer` in web/lib/travel-rule.ts. ADDITIVE only
    //, NOT yet wired into the send path (see TRAVEL_RULE_INTEGRATION_POINT
    // in that module).
    `CREATE TABLE IF NOT EXISTS travel_rule_records (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      route TEXT NOT NULL,
      obligation TEXT NOT NULL,
      amount_usd DOUBLE PRECISION NOT NULL,
      recipient_kind TEXT NOT NULL,
      beneficiary_address TEXT,
      ivms101_json TEXT,
      network_transfer_id TEXT,
      status TEXT,
      created_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_travel_rule_user ON travel_rule_records(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_travel_rule_created ON travel_rule_records(created_at DESC)`,

    // ─── fast-load snapshot caches (display-only, stale-while-revalidate) ──
    // DURABLE, cross-instance caches that let the hot Home endpoints serve a
    // last-known value in one indexed PK read (~10-50ms) instead of a live
    // Sui chain read (USDsui balance ~600-1800ms, activity scan ~1-3s). The
    // perf-cache.ts memoTtl is in-process only, so cold/other serverless
    // instances re-pay full chain latency, these tables survive cold starts.
    //
    // HARD INVARIANT: these are DISPLAY-ONLY. Nothing here may be consulted
    // for a send/withdraw/sweep build or any limit/eligibility check, those
    // stay on the live chain + the authoritative send_limit ledger. A stale
    // snapshot can only ever mislead a pixel, never the bytes of a tx.
    // `*_refreshed_at` (epoch ms) drives staleness; `*_source` marks where
    // the row came from ('chain' = fresh live read, 'stale' = served past TTL).
    `CREATE TABLE IF NOT EXISTS user_balance_snapshot (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      sui_address TEXT NOT NULL,
      usdsui DOUBLE PRECISION NOT NULL DEFAULT 0,
      sui DOUBLE PRECISION NOT NULL DEFAULT 0,
      sui_price_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      total_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      wallet_coins_json TEXT,
      source TEXT NOT NULL DEFAULT 'chain',
      refreshed_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    // entries_json mirrors the exact ActivityEntry[] the /api/activity route
    // already serialises, so serving from cache is a verbatim replay.
    `CREATE TABLE IF NOT EXISTS user_activity_snapshot (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      address TEXT NOT NULL,
      limit_n INTEGER NOT NULL DEFAULT 20,
      entries_json TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'chain',
      refreshed_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    // insights_json mirrors the exact MonthInsights payload /api/rewards/
    // insights serialises, so serving from cache is a verbatim replay. Only
    // ever written from a COMPLETE activity read (complete: true), a
    // timed-out read must never become the last-known value (2026-06-11
    // incident principle: a failed read is not a genuine zero).
    `CREATE TABLE IF NOT EXISTS user_insights_snapshot (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      address TEXT NOT NULL,
      insights_json TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'chain',
      refreshed_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    // Tiny global key/value cache for values that are the SAME for every user
    // (e.g. the SUI/USDC spot price). Shared across instances so a cold
    // function never pays the 800-2000ms DeepBook quote on the hot path.
    `CREATE TABLE IF NOT EXISTS global_kv (
      k TEXT PRIMARY KEY,
      v_num DOUBLE PRECISION,
      v_text TEXT,
      refreshed_at BIGINT NOT NULL
    )`,
    // Cache the resolved on-chain *.talise.sui subname so /api/me and the
    // activity counterparty fan-out stop doing cold reverse-SuiNS walks for a
    // near-immutable name. NULL until first resolved.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS suins_subname TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS suins_subname_at BIGINT`,

    // ─── app_allowlist (private-beta access gate) ────────────────────
    // The /app and /business surfaces are open to sign-in but GATED to
    // explicitly-granted emails. One row per allowed email (lowercased).
    // Grants come from the admin API (/api/admin/app-access) or direct SQL;
    // APP_ALLOWED_EMAILS env is a belt-and-braces bootstrap that always
    // passes even if this table is unreachable.
    `CREATE TABLE IF NOT EXISTS app_allowlist (
      email TEXT PRIMARY KEY,
      granted_at BIGINT NOT NULL,
      granted_by TEXT,
      note TEXT
    )`,
  ];

  // ─── int4 → int8 widener spec (cross-section migration) ────────────
  // The original Postgres migration shipped briefly with `INTEGER` for
  // ms-precision timestamps; `Date.now()` is ~1.78 trillion today, well
  // beyond int4's ~2.15B limit, so inserts blow up with:
  //   ERROR: value "1779729508821" is out of range for type integer
  // `CREATE TABLE IF NOT EXISTS` won't fix an already-narrow column -
  // need an explicit ALTER. Gate each on `information_schema.columns`
  // so the migration is a no-op once columns are already int8.
  // (Declared BEFORE the version gate below so the hash covers it.)
  const tsColumns: Array<[string, string]> = [
    ["users", "created_at"],
    ["users", "last_seen_at"],
    ["users", "notified_at"],
    ["tx_history", "created_at"],
    ["invoices", "created_at"],
    ["invoices", "paid_at"],
    ["rewards_events", "created_at"],
    ["savings_goals", "created_at"],
    ["savings_goals", "deadline_ms"],
    ["redemptions", "created_at"],
    ["redemptions", "fulfilled_at"],
    // mobile_sessions is created out-of-band in lib/mobile-sessions.ts
    // but suffers from the same int4 issue, fold it in here so the
    // widener covers it on first cold start.
    ["mobile_sessions", "created_at"],
    ["mobile_sessions", "expires_at"],
    ["mobile_sessions", "max_epoch"],
  ];

  // ─── Schema-version fast path ───────────────────────────────────────
  // The DDL below is ~114 sequential round-trips. Against a remote box at
  // ~180ms RTT that is ~20 SECONDS on EVERY cold start (each dev restart,
  // each cold serverless lambda), the dominant cold-start cost we measured.
  // The statements are pure data, so hash them: if the stored marker matches,
  // the DB is already at exactly this schema and we skip the entire replay
  // for the cost of ONE SELECT. Any edit to the DDL (or the widener spec)
  // changes the hash, so the next cold start replays the idempotent DDL once
  // and re-stamps. A missing global_kv (fresh DB) or any read error simply
  // falls through to the full replay.
  const schemaHash = createHash("sha256")
    .update(stmts.join(";"))
    .update(JSON.stringify(tsColumns))
    .digest("hex")
    .slice(0, 16);
  try {
    const mark = await c.execute({
      sql: `SELECT v_text FROM global_kv WHERE k = 'schema_version'`,
      args: [],
    });
    if ((mark.rows[0]?.v_text as string | undefined) === schemaHash) return;
  } catch {
    /* global_kv not created yet, fresh DB, run the full DDL below */
  }

  for (const stmt of stmts) {
    try {
      await c.execute(stmt);
    } catch {
      /* idempotent; ALTERs against missing tables on first cold start
         will throw harmlessly, the CREATE above eventually wins. */
    }
  }

  for (const [table, col] of tsColumns) {
    try {
      const r = await c.execute({
        sql: `SELECT data_type FROM information_schema.columns
              WHERE table_name = ? AND column_name = ?`,
        args: [table, col],
      });
      const dt = r.rows[0]?.data_type as string | undefined;
      if (dt === "integer") {
        await c.execute(
          `ALTER TABLE ${table} ALTER COLUMN ${col} TYPE BIGINT USING ${col}::bigint`
        );
      }
    } catch {
      /* table not yet created, fresh DBs get BIGINT from CREATE above */
    }
  }

  // Stamp the schema version so the next cold start takes the one-SELECT fast
  // path instead of replaying ~114 DDL round-trips. Best-effort: a failed
  // stamp just means the next cold start replays the idempotent DDL again.
  try {
    await c.execute({
      sql: `INSERT INTO global_kv (k, v_text, refreshed_at) VALUES ('schema_version', ?, ?)
            ON CONFLICT (k) DO UPDATE SET v_text = EXCLUDED.v_text, refreshed_at = EXCLUDED.refreshed_at`,
      args: [schemaHash, Date.now()],
    });
  } catch {
    /* non-fatal */
  }
}

/**
 * One-SELECT schema-version gate for the self-bootstrapping FEATURE schemas
 * (cheques / streams / mobile-sessions), mirroring the main ensureSchema fast
 * path above. `hashInput` should be the feature's DDL joined into one string -
 * any DDL edit changes the hash, so the next cold start replays once and
 * re-stamps. Returns `upToDate: true` when the stored marker matches (caller
 * skips its DDL), plus a `stamp()` to call after a successful replay.
 */
export async function schemaVersionGate(
  key: string,
  hashInput: string
): Promise<{ upToDate: boolean; stamp: () => Promise<void> }> {
  const c = db();
  const hash = createHash("sha256").update(hashInput).digest("hex").slice(0, 16);
  try {
    const r = await c.execute({
      sql: `SELECT v_text FROM global_kv WHERE k = ?`,
      args: [key],
    });
    if ((r.rows[0]?.v_text as string | undefined) === hash) {
      return { upToDate: true, stamp: async () => {} };
    }
  } catch {
    /* global_kv missing, fall through to replay */
  }
  return {
    upToDate: false,
    stamp: async () => {
      try {
        await c.execute({
          sql: `INSERT INTO global_kv (k, v_text, refreshed_at) VALUES (?, ?, ?)
                ON CONFLICT (k) DO UPDATE SET v_text = EXCLUDED.v_text, refreshed_at = EXCLUDED.refreshed_at`,
          args: [key, hash, Date.now()],
        });
      } catch {
        /* non-fatal, next cold start just replays the idempotent DDL */
      }
    },
  };
}

/**
 * Sum of a user's off-ramp USDsui (≈ USD 1:1) in the trailing window, from the
 * `linq_offramps` ledger. Powers the per-account DAILY cash-out cap. Terminal-
 * failure rows are excluded so a bounced/cancelled order doesn't burn the
 * allowance. `manual_requested` (concierge) rows are also excluded, concierge
 * is the manually-reviewed "do more" path (the KYC escape hatch), so it neither
 * consumes nor is bounded by the automated self-serve daily cap.
 */
export async function sumRecentOfframpUsd(
  userId: number | string,
  sinceMs: number
): Promise<number> {
  await ensureSchema();
  const r = await db().execute({
    sql: `SELECT COALESCE(SUM(amount_usdsui), 0) AS total
            FROM linq_offramps
           WHERE user_id = ? AND created_at >= ?
             AND status NOT IN ('failed', 'cancelled', 'rejected', 'expired', 'manual_requested')`,
    args: [String(userId), sinceMs],
  });
  return Number(r.rows[0]?.total ?? 0);
}

export async function dbHealth(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    await ensureSchema();
    await db().execute("SELECT 1");
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: (err as Error).message,
    };
  }
}

// ───────────────────────────────────────────────────────────────────
// Domain types + query helpers, unchanged from the libsql version

export type AccountType = "personal" | "business";

export type User = {
  id: number;
  google_sub: string;
  email: string;
  name: string | null;
  picture: string | null;
  sui_address: string;
  salt: string;
  country: string | null;
  created_at: number;
  last_seen_at: number;
  notified_at: number | null;
  account_type: AccountType | null;
  business_name: string | null;
  business_handle: string | null;
  business_industry: string | null;
  talise_username: string | null;
  /** Cached resolved on-chain `<handle>.talise.sui` subname + when (epoch ms). */
  suins_subname?: string | null;
  suins_subname_at?: number | null;
  spot_bm_id?: string | null;
  interests?: string | null;
  notify_on_receive?: number | null;
  payment_registry_id?: string | null;
  referral_code?: string | null;
  referred_by_user_id?: number | null;
  referral_count?: number | null;
  points_total?: number | null;
  roundup_enabled?: number | null;
  roundup_percentage?: number | null;
  lifetime_sent_usd?: number | null;
  lifetime_saved_usd?: number | null;
  talise_vault_id?: string | null;
  talise_vault_subname_repointed?: number | null;
  kyc_tier?: number | null;
  /** Epoch ms the user deleted their account in-app (null = active). */
  deleted_at?: number | null;
};

/**
 * Set the user's `talise_vault_id`. Called from `/api/vault/record` after
 * the user-signed `vault::create()` tx confirms on chain.
 *
 * Idempotent: a second call with the same vault id is a no-op. A second
 * call with a *different* id throws, we expect exactly one vault per
 * user. Callers can pass `{ force: true }` to bypass that check during
 * v1 mainnet migration (re-pointing legacy users to a fresh vault).
 */
export async function setTaliseVaultId(
  userId: number,
  vaultId: string,
  opts: { force?: boolean } = {}
): Promise<void> {
  await ensureSchema();
  const c = db();
  const cur = await c.execute({
    sql: "SELECT talise_vault_id FROM users WHERE id = ? LIMIT 1",
    args: [userId],
  });
  const existing = cur.rows[0]?.talise_vault_id as string | null | undefined;
  if (existing && existing !== vaultId && !opts.force) {
    throw new Error(
      `user ${userId} already has talise_vault_id=${existing}; refusing to overwrite without force`
    );
  }
  await c.execute({
    sql: "UPDATE users SET talise_vault_id = ? WHERE id = ?",
    args: [vaultId, userId],
  });
}

/** Mark the user's SuiNS subname as having been repointed to the vault. */
export async function markVaultSubnameRepointed(userId: number): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: "UPDATE users SET talise_vault_subname_repointed = 1 WHERE id = ?",
    args: [userId],
  });
}

export type RewardsEventKind =
  | "referral_signup"
  | "referral_first_send"
  | "volume_milestone"
  | "first_send"
  | "first_claim"
  | "streak"
  | "send_earn"
  | "save_earn"
  | "roundup_save"
  | "withdraw_earn"
  | "goal_deposit"
  | "swap_earn"
  | "redeemed";

export type RewardsEvent = {
  id: number;
  user_id: number;
  kind: RewardsEventKind;
  points: number;
  metadata: string | null;
  created_at: number;
};

export function hasBusiness(user: User): boolean {
  return !!user.business_handle;
}

export async function switchActiveContext(
  userId: number,
  to: AccountType
): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: "UPDATE users SET account_type = ? WHERE id = ?",
    args: [to, userId],
  });
}

export async function addBusinessProfile(
  userId: number,
  input: {
    businessName: string;
    businessHandle: string;
    businessIndustry?: string | null;
  }
): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: `UPDATE users SET
      business_name = ?,
      business_handle = ?,
      business_industry = ?,
      account_type = 'business'
      WHERE id = ?`,
    args: [
      input.businessName,
      input.businessHandle.toLowerCase(),
      input.businessIndustry ?? null,
      userId,
    ],
  });
}

export async function setAccountType(
  userId: number,
  input: {
    accountType: AccountType;
    businessName?: string | null;
    businessHandle?: string | null;
    businessIndustry?: string | null;
    interests?: string[] | null;
    country?: string | null;
    notifyOnReceive?: boolean;
  }
) {
  await ensureSchema();
  await db().execute({
    sql: `UPDATE users SET
      account_type = ?,
      business_name = ?,
      business_handle = ?,
      business_industry = ?,
      interests = ?,
      country = COALESCE(?, country),
      notify_on_receive = ?
      WHERE id = ?`,
    args: [
      input.accountType,
      input.businessName ?? null,
      input.businessHandle ?? null,
      input.businessIndustry ?? null,
      input.interests ? input.interests.join(",") : null,
      input.country ?? null,
      input.notifyOnReceive ? 1 : 0,
      userId,
    ],
  });
}

/**
 * Set ONLY the user's country (ISO alpha-2). Additive + idempotent, does NOT
 * touch account_type, so it's safe to call from the onboarding country step
 * and a profile edit without interfering with account completion.
 */
export async function setUserCountry(userId: number, country: string): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: "UPDATE users SET country = ? WHERE id = ?",
    args: [country, userId],
  });
}

/** Set (or clear, with null) the user's avatar override (NFT/image URL). */
export async function setUserPfp(userId: number, pfpUrl: string | null): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: "UPDATE users SET pfp_url = ? WHERE id = ?",
    args: [pfpUrl, userId],
  });
}

export async function isHandleTaken(handle: string): Promise<boolean> {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT id FROM users WHERE business_handle = ? LIMIT 1",
    args: [handle],
  });
  return r.rows.length > 0;
}

export type TxRow = {
  id: number;
  user_id: number;
  digest: string;
  kind: string;
  amount: string | null;
  asset: string | null;
  recipient: string | null;
  memo: string | null;
  receipt_object_id: string | null;
  created_at: number;
};

/** Decrypt the at-rest-encrypted salt on a freshly-read user row (in place). */
function hydrateUser<T extends { salt?: string | null } | null | undefined>(u: T): T {
  if (u && typeof u.salt === "string" && u.salt) {
    (u as { salt: string | null }).salt = decryptAtRest(u.salt);
  }
  return u;
}

export async function upsertUser(input: {
  googleSub: string;
  email: string;
  name?: string | null;
  picture?: string | null;
  suiAddress: string;
  salt: string;
  country?: string | null;
}): Promise<{ user: User; isNew: boolean }> {
  await ensureSchema();
  const c = db();
  const now = Date.now();

  const existing = await c.execute({
    sql: "SELECT * FROM users WHERE google_sub = ? LIMIT 1",
    args: [input.googleSub],
  });

  if (existing.rows.length > 0) {
    await c.execute({
      sql: "UPDATE users SET last_seen_at = ?, name = ?, picture = ? WHERE google_sub = ?",
      args: [
        now,
        input.name ?? null,
        input.picture ?? null,
        input.googleSub,
      ],
    });
    const row = await c.execute({
      sql: "SELECT * FROM users WHERE google_sub = ? LIMIT 1",
      args: [input.googleSub],
    });
    const u = hydrateUser(row.rows[0] as unknown as User);
    await ensureReferralCode(u.id, input.name ?? input.email);
    const refreshed = await c.execute({
      sql: "SELECT * FROM users WHERE id = ? LIMIT 1",
      args: [u.id],
    });
    return { user: hydrateUser(refreshed.rows[0] as unknown as User), isNew: false };
  }

  // Default new users to a 'personal' account_type. Onboarding/KYC was
  // removed, a new user signs in and goes STRAIGHT into the app, so the
  // KYC step that used to set this never runs. A populated account_type
  // also keeps the client's phase logic on the `.ready` path (a null type
  // routed to the old `.onboarding`/KYC screen). Users can still upgrade
  // to 'business' later from settings.
  await c.execute({
    sql: `INSERT INTO users
      (google_sub, email, name, picture, sui_address, salt, country, account_type, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.googleSub,
      input.email,
      input.name ?? null,
      input.picture ?? null,
      input.suiAddress,
      encryptAtRest(input.salt),
      input.country ?? null,
      "personal",
      now,
      now,
    ],
  });

  const row = await c.execute({
    sql: "SELECT * FROM users WHERE google_sub = ? LIMIT 1",
    args: [input.googleSub],
  });
  const created = hydrateUser(row.rows[0] as unknown as User);
  await ensureReferralCode(created.id, input.name ?? input.email);
  const refreshed = await c.execute({
    sql: "SELECT * FROM users WHERE id = ? LIMIT 1",
    args: [created.id],
  });
  return { user: hydrateUser(refreshed.rows[0] as unknown as User), isNew: true };
}

export async function realignAddress(
  userId: number,
  suiAddress: string,
  salt: string
): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: "UPDATE users SET sui_address = ?, salt = ? WHERE id = ?",
    args: [suiAddress, encryptAtRest(salt), userId],
  });
}

export async function userById(id: number): Promise<User | null> {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT * FROM users WHERE id = ? LIMIT 1",
    args: [id],
  });
  const u = hydrateUser((r.rows[0] as unknown as User) ?? null);
  // A deleted account no longer exists for any authed surface. The web
  // session cookie is stateless (no server-side store to revoke), but every
  // authed route resolves the user through here, so filtering deleted rows
  // is the chokepoint that retires any still-circulating cookie after an
  // in-app account deletion (markUserDeleted). Mobile bearers are revoked
  // explicitly in the delete route.
  if (u?.deleted_at) return null;
  return u;
}

/**
 * Raw row read that does NOT filter deleted accounts, needed by
 * markUserDeleted's idempotency check (and any future admin tooling).
 */
export async function userByIdIncludingDeleted(id: number): Promise<User | null> {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT * FROM users WHERE id = ? LIMIT 1",
    args: [id],
  });
  return hydrateUser((r.rows[0] as unknown as User) ?? null);
}

export async function userByGoogleSub(sub: string): Promise<User | null> {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT * FROM users WHERE google_sub = ? LIMIT 1",
    args: [sub],
  });
  return hydrateUser((r.rows[0] as unknown as User) ?? null);
}

// ───────────────────────────────────────────────────────────────────
// Apple zkLogin salts, LOCAL fallback for Sign in with Apple.
//
// The primary salt source is Shinami's zkLogin Wallet service (keyed per
// iss+sub on their side). If Shinami rejects an apple-issuer JWT (unknown
// audience/issuer), we fall back to this table. The salt determines the
// user's Sui address, so it is written ONCE per subject and never changes:
// INSERT ... ON CONFLICT DO NOTHING, then SELECT the canonical row.
//
// Self-bootstrapping schema, same memoized-promise + version-gate idiom as
// mobile-sessions (this is NOT on the hot auth path, only the Apple
// sign-in exchange touches it).

const APPLE_SALTS_DDL = `
  CREATE TABLE IF NOT EXISTS apple_salts (
    iss_sub TEXT PRIMARY KEY,
    salt TEXT NOT NULL,
    created_at BIGINT
  )
`;

let _appleSaltsReadyP: Promise<void> | null = null;

async function ensureAppleSaltsSchema(): Promise<void> {
  if (!_appleSaltsReadyP) {
    _appleSaltsReadyP = (async () => {
      await ensureSchema();
      const gate = await schemaVersionGate(
        "apple_salts_schema_version",
        APPLE_SALTS_DDL
      );
      if (gate.upToDate) return;
      await db().execute(APPLE_SALTS_DDL);
      await gate.stamp();
    })().catch((e) => {
      _appleSaltsReadyP = null; // retry on next call instead of caching failure
      throw e;
    });
  }
  return _appleSaltsReadyP;
}

/** Read the locally-stored Apple salt for `iss_sub` (null if none yet). */
export async function localAppleSalt(issSub: string): Promise<string | null> {
  await ensureAppleSaltsSchema();
  const r = await db().execute({
    sql: "SELECT salt FROM apple_salts WHERE iss_sub = ? LIMIT 1",
    args: [issSub],
  });
  return decryptAtRest(r.rows[0]?.salt as string | undefined) ?? null;
}

/**
 * Store `candidateSalt` for `iss_sub` ONLY if no salt exists yet, then return
 * the canonical stored salt. Concurrent first sign-ins race safely: ON
 * CONFLICT DO NOTHING means exactly one INSERT wins and both callers read
 * back the same winning row, the salt for a subject can never change.
 */
export async function getOrCreateLocalAppleSalt(
  issSub: string,
  candidateSalt: string
): Promise<string> {
  await ensureAppleSaltsSchema();
  const c = db();
  await c.execute({
    sql: `INSERT INTO apple_salts (iss_sub, salt, created_at)
          VALUES (?, ?, ?)
          ON CONFLICT (iss_sub) DO NOTHING`,
    args: [issSub, encryptAtRest(candidateSalt), Date.now()],
  });
  const r = await c.execute({
    sql: "SELECT salt FROM apple_salts WHERE iss_sub = ? LIMIT 1",
    args: [issSub],
  });
  const stored = decryptAtRest(r.rows[0]?.salt as string | undefined) ?? undefined;
  if (!stored) {
    throw new Error(`apple_salts insert/select failed for ${issSub}`);
  }
  return stored;
}

/**
 * Look up a user by their Sui address (UNIQUE). Case-insensitive, send
 * paths lowercase the recipient, but the stored address may be mixed case.
 * Used to resolve the RECIPIENT of an inbound transfer so we can notify them.
 * Returns null for an external (non-Talise) address.
 */
export async function userBySuiAddress(address: string): Promise<User | null> {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT * FROM users WHERE LOWER(sui_address) = LOWER(?) LIMIT 1",
    args: [address],
  });
  return hydrateUser((r.rows[0] as unknown as User) ?? null);
}

/**
 * In-app account deletion (App Store Guideline 5.1.1(v)).
 *
 * Soft delete + PII redaction, NOT a row drop, dozens of financial tables
 * FK onto users(id) and those records must survive for bookkeeping + AML
 * record-keeping obligations. What happens:
 *
 *   • google_sub  → `deleted:<id>:<ts>`, breaks the Google→account link,
 *     so a future sign-in with the same Google account creates a FRESH row
 *     instead of resurrecting this one. (The wallet is self-custodial: the
 *     same Google identity re-derives the same zkLogin address via Shinami,
 *     so funds are never lost, only the Talise profile is gone.)
 *   • sui_address → `deleted:<id>:<addr>`, frees the UNIQUE constraint for
 *     that fresh re-signup row while keeping the address inside the value
 *     for audit. Lookups (userBySuiAddress) no longer match.
 *   • email/name/picture + business profile + talise_username → redacted.
 *     Clearing talise_username releases the server-side handle mapping
 *     (the on-chain SuiNS subname stays with the user's wallet).
 *   • salt → 'deleted', Shinami remains the salt source of truth.
 *   • PII side tables, linked bank accounts, push tokens, display
 *     snapshots, savings goals, are deleted outright.
 *
 * KEPT: tx_history, transfers, invoices, linq_offramps, rewards ledger,
 * KYC/travel-rule artifacts (legally retained), cheques/streams escrows
 * (claimable by recipients independent of the issuer's profile).
 *
 * Idempotent, a second call on an already-deleted row is a no-op.
 * Callers must also revoke sessions (revokeAllMobileSessions + cookie).
 */
export async function markUserDeleted(userId: number): Promise<void> {
  await ensureSchema();
  const c = db();
  const u = await userByIdIncludingDeleted(userId);
  if (!u) return;
  if (u.deleted_at || u.google_sub.startsWith("deleted:")) return;

  const now = Date.now();
  await c.execute({
    sql: `UPDATE users SET
            google_sub = ?,
            sui_address = ?,
            email = ?,
            name = NULL,
            picture = NULL,
            salt = 'deleted',
            country = NULL,
            business_name = NULL,
            business_handle = NULL,
            business_industry = NULL,
            interests = NULL,
            talise_username = NULL,
            notify_on_receive = 0,
            deleted_at = ?
          WHERE id = ?`,
    args: [
      `deleted:${userId}:${now}`,
      `deleted:${userId}:${u.sui_address}`,
      `deleted:${userId}@redacted.invalid`,
      now,
      userId,
    ],
  });

  // PII side tables, hard-delete. Each is independent; a failure on one
  // (e.g. a table that predates this feature) must not abort the rest.
  const cleanups: Array<{ sql: string; args: (string | number)[] }> = [
    // Linked NGN bank accounts (account numbers + names). TEXT user_id.
    { sql: `DELETE FROM user_bank_accounts WHERE user_id = ?`, args: [String(userId)] },
    // APNs push tokens, device must stop receiving pushes post-delete.
    { sql: `DELETE FROM device_token WHERE user_id = ?`, args: [userId] },
    // Display-only snapshot caches.
    { sql: `DELETE FROM user_balance_snapshot WHERE user_id = ?`, args: [userId] },
    { sql: `DELETE FROM user_activity_snapshot WHERE user_id = ?`, args: [userId] },
    { sql: `DELETE FROM user_insights_snapshot WHERE user_id = ?`, args: [userId] },
    // User-authored savings buckets (free-text names).
    { sql: `DELETE FROM savings_goals WHERE user_id = ?`, args: [userId] },
  ];
  for (const stmt of cleanups) {
    try {
      await c.execute(stmt);
    } catch {
      /* best-effort PII cleanup, never abort the deletion itself */
    }
  }
}

/**
 * Register (upsert) an APNs/push device token for a user. `token` is UNIQUE,
 * so re-registering the same device, or moving it to a new account -
 * rebinds it rather than duplicating.
 */
export async function registerDeviceToken(
  userId: number,
  token: string,
  platform = "ios"
): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: `INSERT INTO device_token (user_id, token, platform, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (token) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            platform = EXCLUDED.platform,
            updated_at = EXCLUDED.updated_at`,
    args: [userId, token, platform, Date.now()],
  });
}

/** All registered push tokens for a user (one per device). */
export async function deviceTokensForUser(userId: number): Promise<string[]> {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT token FROM device_token WHERE user_id = ?",
    args: [userId],
  });
  return r.rows.map((row) => String((row as { token: string }).token));
}

export async function userByBusinessHandle(
  handle: string
): Promise<User | null> {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT * FROM users WHERE business_handle = ? LIMIT 1",
    args: [handle.toLowerCase()],
  });
  return hydrateUser((r.rows[0] as unknown as User) ?? null);
}

export async function updateUserProfile(
  userId: number,
  input: {
    name?: string | null;
    businessName?: string | null;
    businessIndustry?: string | null;
    country?: string | null;
    notifyOnReceive?: boolean;
  }
) {
  await ensureSchema();
  await db().execute({
    sql: `UPDATE users SET
      name = COALESCE(?, name),
      business_name = COALESCE(?, business_name),
      business_industry = COALESCE(?, business_industry),
      country = COALESCE(?, country),
      notify_on_receive = COALESCE(?, notify_on_receive)
      WHERE id = ?`,
    args: [
      input.name ?? null,
      input.businessName ?? null,
      input.businessIndustry ?? null,
      input.country ?? null,
      typeof input.notifyOnReceive === "boolean"
        ? input.notifyOnReceive
          ? 1
          : 0
        : null,
      userId,
    ],
  });
}

/**
 * Overwrite a user's email. Used only to replace an Apple "Hide My Email"
 * relay address (`@privaterelay.appleid.com`, which can't complete Bridge KYC)
 * with a real email the user supplies at verification time. `email` is a
 * non-unique index, so this is a plain lower-cased update.
 */
export async function updateUserEmail(
  userId: number,
  email: string
): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: "UPDATE users SET email = ? WHERE id = ?",
    args: [email.trim().toLowerCase(), userId],
  });
}

export async function setPaymentRegistry(
  userId: number,
  objectId: string
): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: "UPDATE users SET payment_registry_id = ? WHERE id = ?",
    args: [objectId, userId],
  });
}

export async function setInvoiceReceiptObjectId(
  slug: string,
  receiptObjectId: string
): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: "UPDATE invoices SET receipt_object_id = ? WHERE slug = ?",
    args: [receiptObjectId, slug],
  });
}

export async function setSpotBalanceManagerId(userId: number, bmId: string) {
  await ensureSchema();
  await db().execute({
    sql: "UPDATE users SET spot_bm_id = ? WHERE id = ?",
    args: [bmId, userId],
  });
}

export async function userCount(): Promise<number> {
  await ensureSchema();
  const r = await db().execute("SELECT COUNT(*) AS n FROM users");
  const v = r.rows[0]?.n;
  return typeof v === "number" ? v : Number(v ?? 0);
}

export async function userPosition(id: number): Promise<number> {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT COUNT(*) AS n FROM users WHERE id <= ?",
    args: [id],
  });
  const v = r.rows[0]?.n;
  return typeof v === "number" ? v : Number(v ?? 0);
}

export async function markNotified(userId: number) {
  await ensureSchema();
  await db().execute({
    sql: "UPDATE users SET notified_at = ? WHERE id = ?",
    args: [Date.now(), userId],
  });
}

export async function recordTx(input: {
  userId: number;
  digest: string;
  kind: string;
  amount?: string | null;
  asset?: string | null;
  recipient?: string | null;
  memo?: string | null;
  receiptObjectId?: string | null;
}): Promise<void> {
  await ensureSchema();
  try {
    await db().execute({
      sql: `INSERT INTO tx_history
        (user_id, digest, kind, amount, asset, recipient, memo, receipt_object_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        input.userId,
        input.digest,
        input.kind,
        input.amount ?? null,
        input.asset ?? null,
        input.recipient ?? null,
        input.memo ?? null,
        input.receiptObjectId ?? null,
        Date.now(),
      ],
    });
  } catch (e) {
    const msg = String((e as Error).message);
    // Postgres reports duplicate key violations as "duplicate key value violates
    // unique constraint"; libsql said "UNIQUE constraint failed". Swallow both.
    if (!msg.includes("UNIQUE") && !msg.toLowerCase().includes("duplicate key")) {
      throw e;
    }
  }
}

export type Invoice = {
  id: number;
  business_user_id: number;
  slug: string;
  amount_usdc: string;
  reference: string | null;
  customer_email: string | null;
  status: "open" | "paid" | "void";
  created_at: number;
  paid_at: number | null;
  paid_digest: string | null;
  paid_by_address: string | null;
  receipt_object_id?: string | null;
};

export async function createInvoice(input: {
  businessUserId: number;
  amountUsdc: string;
  reference: string | null;
  customerEmail: string | null;
}): Promise<Invoice> {
  await ensureSchema();
  const slug = invoiceSlug();
  const now = Date.now();
  const c = db();
  await c.execute({
    sql: `INSERT INTO invoices
      (business_user_id, slug, amount_usdc, reference, customer_email, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      input.businessUserId,
      slug,
      input.amountUsdc,
      input.reference,
      input.customerEmail,
      now,
    ],
  });
  const r = await c.execute({
    sql: "SELECT * FROM invoices WHERE slug = ? LIMIT 1",
    args: [slug],
  });
  return r.rows[0] as unknown as Invoice;
}

export async function invoicesFor(businessUserId: number): Promise<Invoice[]> {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT * FROM invoices WHERE business_user_id = ? ORDER BY created_at DESC",
    args: [businessUserId],
  });
  return r.rows as unknown as Invoice[];
}

export async function invoiceBySlug(slug: string): Promise<Invoice | null> {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT * FROM invoices WHERE slug = ? LIMIT 1",
    args: [slug],
  });
  return (r.rows[0] as unknown as Invoice) ?? null;
}

export async function markInvoicePaid(
  slug: string,
  digest: string,
  payerAddress: string
) {
  await ensureSchema();
  await db().execute({
    sql: `UPDATE invoices SET status = 'paid', paid_at = ?, paid_digest = ?, paid_by_address = ?
      WHERE slug = ? AND status = 'open'`,
    args: [Date.now(), digest, payerAddress, slug],
  });
}

function invoiceSlug(): string {
  return Math.random().toString(36).slice(2, 6) +
    Math.random().toString(36).slice(2, 6);
}

export async function userTxs(userId: number, limit = 20): Promise<TxRow[]> {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT * FROM tx_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
    args: [userId, limit],
  });
  return r.rows as unknown as TxRow[];
}

// --- Referrals + Rewards ---------------------------------------------------

const REFERRAL_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export const REFERRAL_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

function pickFromAlphabet(): string {
  const idx = Math.floor(Math.random() * REFERRAL_ALPHABET.length);
  return REFERRAL_ALPHABET[idx];
}

export function generateReferralCode(seed?: string | null): string {
  let prefix = "";
  if (seed) {
    const cleaned = seed
      .toUpperCase()
      .replace(/[O0]/g, "")
      .replace(/[IL1]/g, "")
      .split("")
      .filter((ch) => REFERRAL_ALPHABET.includes(ch))
      .join("");
    prefix = cleaned.slice(0, 4);
  }
  let code = prefix;
  while (code.length < 8) code += pickFromAlphabet();
  return code;
}

export async function ensureReferralCode(
  userId: number,
  seed?: string | null
): Promise<string> {
  await ensureSchema();
  const c = db();
  const existing = await c.execute({
    sql: "SELECT referral_code FROM users WHERE id = ? LIMIT 1",
    args: [userId],
  });
  const cur = existing.rows[0]?.referral_code;
  if (typeof cur === "string" && cur.length === 8) return cur;

  for (let attempt = 0; attempt < 12; attempt++) {
    const code = generateReferralCode(attempt === 0 ? seed : null);
    try {
      const r = await c.execute({
        sql: "UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL",
        args: [code, userId],
      });
      if (r.rowsAffected && r.rowsAffected > 0) return code;
      const r2 = await c.execute({
        sql: "SELECT referral_code FROM users WHERE id = ? LIMIT 1",
        args: [userId],
      });
      const v = r2.rows[0]?.referral_code;
      if (typeof v === "string" && v.length === 8) return v;
    } catch (e) {
      const msg = String((e as Error).message).toUpperCase();
      if (!msg.includes("UNIQUE") && !msg.includes("DUPLICATE KEY")) throw e;
    }
  }
  throw new Error("could not allocate a referral code after 12 attempts");
}

export async function userByReferralCode(code: string): Promise<User | null> {
  await ensureSchema();
  const normalized = code.trim().toUpperCase();
  if (!REFERRAL_CODE_RE.test(normalized)) return null;
  const r = await db().execute({
    sql: "SELECT * FROM users WHERE referral_code = ? LIMIT 1",
    args: [normalized],
  });
  return hydrateUser((r.rows[0] as unknown as User) ?? null);
}

/**
 * Resolve a user by their claimed Talise handle (`users.talise_username`,
 * UNIQUE). Case-insensitive, handles are stored lowercased but we normalize
 * the lookup so a shared `/u/Alice` link still resolves. Powers the public
 * profile page + its OG card.
 */
export async function userByHandle(handle: string): Promise<User | null> {
  await ensureSchema();
  const normalized = handle.trim().toLowerCase().replace(/^@+/, "");
  if (!normalized) return null;
  const r = await db().execute({
    sql: "SELECT * FROM users WHERE LOWER(talise_username) = ? LIMIT 1",
    args: [normalized],
  });
  return hydrateUser((r.rows[0] as unknown as User) ?? null);
}

/**
 * Waitlist position for a user, ranked among the WAITLIST COHORT, members
 * who have claimed a Talise handle (`talise_username IS NOT NULL`), which is
 * exactly who sees this dashboard. (Ranking over all `users` would fold in
 * fully-onboarded / business accounts and make the line meaningless.) Order is
 * (referral_count DESC, created_at ASC, id ASC): more verified referrals pull
 * you toward the front; ties break by who joined first. Returns a 1-based
 * `position` (1 = front of the line) and the cohort `total`.
 *
 * Single correlated query, `ahead` counts cohort members strictly in front of
 * `me`, so position = ahead + 1. COALESCE guards the nullable referral_count.
 * Cheap at waitlist scale; move to a materialized rank past ~1M rows.
 */
export async function getWaitlistRank(
  userId: number
): Promise<{ position: number; total: number }> {
  await ensureSchema();
  const c = db();
  const r = await c.execute({
    sql: `
      SELECT
        (SELECT COUNT(*) FROM users WHERE talise_username IS NOT NULL) AS total,
        (SELECT COUNT(*) FROM users u
           WHERE u.talise_username IS NOT NULL
             AND (COALESCE(u.referral_count, 0) > COALESCE(m.referral_count, 0)
                  OR (COALESCE(u.referral_count, 0) = COALESCE(m.referral_count, 0)
                      AND (u.created_at < m.created_at
                           OR (u.created_at = m.created_at AND u.id < m.id))))
        ) AS ahead
      FROM users m
      WHERE m.id = ?
      LIMIT 1`,
    args: [userId],
  });
  const row = r.rows[0];
  if (!row) return { position: 0, total: 0 };
  const total = Number(row.total ?? 0) || 0;
  const ahead = Number(row.ahead ?? 0) || 0;
  return { position: ahead + 1, total };
}

export async function recordRewardsEvent(
  userId: number,
  kind: RewardsEventKind,
  points: number,
  metadata?: Record<string, unknown> | null
): Promise<void> {
  await ensureSchema();
  const c = db();
  const now = Date.now();
  await c.batch(
    [
      {
        sql: `INSERT INTO rewards_events
          (user_id, kind, points, metadata, created_at)
          VALUES (?, ?, ?, ?, ?)`,
        args: [
          userId,
          kind,
          points,
          metadata ? JSON.stringify(metadata) : null,
          now,
        ],
      },
      {
        sql: "UPDATE users SET points_total = COALESCE(points_total, 0) + ? WHERE id = ?",
        args: [points, userId],
      },
    ],
    "write"
  );
}

export async function attributeReferral(
  newUserId: number,
  inviterCode: string,
  points: { referrer: number; referee: number }
): Promise<{ ok: boolean; reason?: string; inviterId?: number }> {
  await ensureSchema();
  const c = db();
  const me = await userById(newUserId);
  if (!me) return { ok: false, reason: "user not found" };
  if (me.referred_by_user_id) {
    return { ok: false, reason: "already referred" };
  }
  const inviter = await userByReferralCode(inviterCode);
  if (!inviter) return { ok: false, reason: "invalid code" };
  if (inviter.id === newUserId) return { ok: false, reason: "self referral" };

  // Atomic claim: only the request that actually flips referred_by_user_id
  // from NULL gets to credit the inviter. The earlier `me.referred_by_user_id`
  // read is a fast-path; THIS rowcount is the real guard. Without gating the
  // increment + events on it, two concurrent attributions (e.g. the auth
  // callback racing onboarding, or a double-submit) both pass the read and
  // double-count the inviter's referral_count + points.
  const claim = await c.execute({
    sql: `UPDATE users SET referred_by_user_id = ?
          WHERE id = ? AND referred_by_user_id IS NULL`,
    args: [inviter.id, newUserId],
  });
  if (!claim.rowsAffected || claim.rowsAffected < 1) {
    return { ok: false, reason: "already referred" };
  }

  await c.execute({
    sql: "UPDATE users SET referral_count = COALESCE(referral_count, 0) + 1 WHERE id = ?",
    args: [inviter.id],
  });

  await recordRewardsEvent(inviter.id, "referral_signup", points.referrer, {
    referredUserId: newUserId,
  });
  await recordRewardsEvent(newUserId, "referral_signup", points.referee, {
    inviterUserId: inviter.id,
  });

  return { ok: true, inviterId: inviter.id };
}

export async function getRewardsSummary(userId: number): Promise<{
  code: string;
  referralCount: number;
  pointsTotal: number;
  recentEvents: RewardsEvent[];
}> {
  await ensureSchema();
  const c = db();
  const code = await ensureReferralCode(userId);

  const r = await c.execute({
    sql: "SELECT referral_count, points_total FROM users WHERE id = ? LIMIT 1",
    args: [userId],
  });
  const row = r.rows[0];
  const referralCount = Number(row?.referral_count ?? 0) || 0;
  const pointsTotal = Number(row?.points_total ?? 0) || 0;

  const ev = await c.execute({
    // Goal deposits/withdrawals are NOT earning events, they move a tracked
    // envelope, mint no points, and only cluttered the feed with "+0" rows.
    // Excluded here so they never appear in Earning History (past or future).
    sql: `SELECT * FROM rewards_events WHERE user_id = ?
          AND kind NOT IN ('goal_deposit', 'goal_withdraw')
          ORDER BY created_at DESC LIMIT 20`,
    args: [userId],
  });

  return {
    code,
    referralCount,
    pointsTotal,
    recentEvents: ev.rows as unknown as RewardsEvent[],
  };
}

// ───────────────────────────────────────────────────────────────────
// roundup_queue helpers
//
// Used by `/api/send/gasless-submit` to fire-and-forget a NAVI supply
// for the rounded-up amount AFTER a gasless USDsui send lands. The
// gasless rail can't co-bundle the supply (PTB allowlist permits only
// `0x2::coin::send_funds<T>`), so we defer it to a cron drain.
//
// Reads happen exclusively from the cron worker
// (`/api/cron/process-roundup-queue`); we keep `markRoundupProcessed`
// here so the cron's update path is co-located with the insert.

export type RoundupQueueRow = {
  id: number;
  user_id: number;
  amount_usd: number;
  created_at: number;
  processed_at: number | null;
  tx_digest: string | null;
};

export async function enqueueRoundup(input: {
  userId: number;
  amountUsd: number;
}): Promise<void> {
  if (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0) return;
  await ensureSchema();
  const c = db();
  await c.execute({
    sql: `INSERT INTO roundup_queue (user_id, amount_usd, created_at)
          VALUES (?, ?, ?)`,
    args: [input.userId, input.amountUsd, Date.now()],
  });
}

export async function pendingRoundups(
  limit = 50
): Promise<RoundupQueueRow[]> {
  await ensureSchema();
  const c = db();
  const r = await c.execute({
    sql: `SELECT id, user_id, amount_usd, created_at, processed_at, tx_digest
          FROM roundup_queue
          WHERE processed_at IS NULL
          ORDER BY created_at ASC
          LIMIT ?`,
    args: [limit],
  });
  return r.rows as unknown as RoundupQueueRow[];
}

export async function markRoundupProcessed(
  id: number,
  txDigest: string
): Promise<void> {
  await ensureSchema();
  const c = db();
  await c.execute({
    sql: `UPDATE roundup_queue SET processed_at = ?, tx_digest = ? WHERE id = ?`,
    args: [Date.now(), txDigest, id],
  });
}

// ─── App allowlist (private-beta access gate) ───────────────────────────────

/** Env bootstrap, comma-separated emails that ALWAYS have access, even if the
 *  DB allowlist is unreachable (fail-open only for these explicit entries).
 *
 *  Two env vars, unioned, so intent stays legible and each is independently
 *  revocable:
 *    • APP_ALLOWED_EMAILS, founders / long-lived team bootstrap.
 *    • APP_REVIEW_EMAILS , App Store / Play reviewer demo account(s). Add the
 *                            reviewer email here to fully enable the account
 *                            (skips the waiting room AND passes every money-API
 *                            403 guardrail, both route through this function).
 *                            Delete the entry to revoke the instant review ends;
 *                            it never widens access for anyone else.
 */
function envAllowedEmails(): Set<string> {
  const raw = [
    process.env.APP_ALLOWED_EMAILS ?? "",
    process.env.APP_REVIEW_EMAILS ?? "",
  ].join(",");
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** Is this email allowed into the gated app surfaces?
 *
 *  PUBLIC BETA: access is OPEN to everyone, Talise has gone live, so any
 *  signed-in account can move money. The allowlist mechanism below is left
 *  intact and can be re-enabled by setting `APP_ACCESS_OPEN=false` (which
 *  reverts to env-bootstrap + app_allowlist gating, fail-closed on DB error).
 */
export async function isAppAccessAllowed(email: string): Promise<boolean> {
  const norm = email.trim().toLowerCase();
  // Explicit env allowlist (founders + reviewers) ALWAYS passes, independent of
  // the open/closed toggle, so an added reviewer email keeps working even if
  // APP_ACCESS_OPEN is later flipped to "false" mid-review. Checked first and
  // costs no DB round-trip.
  if (envAllowedEmails().has(norm)) return true;
  if (process.env.APP_ACCESS_OPEN !== "false") return true;
  try {
    await ensureSchema();
    const r = await db().execute({
      sql: `SELECT 1 FROM app_allowlist WHERE email = ?`,
      args: [norm],
    });
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

export async function grantAppAccess(
  email: string,
  grantedBy: string | null,
  note?: string
): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: `INSERT INTO app_allowlist (email, granted_at, granted_by, note)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (email) DO UPDATE SET granted_by = EXCLUDED.granted_by, note = EXCLUDED.note`,
    args: [email.trim().toLowerCase(), Date.now(), grantedBy, note ?? null],
  });
}

export async function revokeAppAccess(email: string): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: `DELETE FROM app_allowlist WHERE email = ?`,
    args: [email.trim().toLowerCase()],
  });
}

export async function listAppAccess(): Promise<
  Array<{ email: string; granted_at: number; granted_by: string | null; note: string | null }>
> {
  await ensureSchema();
  const r = await db().execute(
    `SELECT email, granted_at, granted_by, note FROM app_allowlist ORDER BY granted_at DESC`
  );
  return r.rows as never;
}
