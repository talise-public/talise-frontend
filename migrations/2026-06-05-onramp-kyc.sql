-- ─────────────────────────────────────────────────────────────────────
-- Migration: on-ramp KYC state  (2026-06-05)
--
-- STATUS: NOT APPLIED. This file is a standalone, hand-runnable migration.
-- The Talise web app manages its schema in-code via `ensureSchema()` in
-- web/lib/db.ts (idempotent CREATE/ALTER on every cold start) — there is no
-- migration runner. To go live you EITHER:
--   (a) fold the statements below into the `stmts: string[]` array in
--       doEnsureSchema() (preferred — keeps the one-source-of-truth), OR
--   (b) run this file once against the Postgres DATABASE_URL by hand.
-- Do NOT run it automatically as part of this scaffold.
--
-- Purpose: persist provider-agnostic on-ramp KYC state per user, layered
-- ON TOP OF the existing integer `users.kyc_tier` (lib/kyc.ts, 0..3) and the
-- append-only `kyc_upgrade_intents` log. This table models the richer,
-- per-provider, per-country tiered model the on-ramp flow needs
-- (none|lite|standard|enhanced) WITHOUT disturbing the existing send/limit
-- tier column, which stays the authoritative send-gate.
--
-- All DDL is Postgres flavour and idempotent (IF NOT EXISTS), matching the
-- conventions in web/lib/db.ts. Timestamps that the app writes use BIGINT
-- epoch-ms elsewhere; `updated_at` here is TIMESTAMPTZ per the scaffold spec
-- (it is set server-side, never parsed as an int ms value).
-- ─────────────────────────────────────────────────────────────────────

-- One KYC record per user. `user_id` references the canonical users row.
-- The on-ramp tier vocabulary (none|lite|standard|enhanced) is stored as
-- TEXT with a CHECK rather than a Postgres ENUM — TEXT+CHECK is what the
-- rest of the schema uses for small closed sets (status columns, account
-- kinds) and avoids the migration friction of ALTER TYPE ... ADD VALUE.
CREATE TABLE IF NOT EXISTS onramp_kyc (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  -- none | lite | standard | enhanced
  kyc_tier TEXT NOT NULL DEFAULT 'none'
    CHECK (kyc_tier IN ('none', 'lite', 'standard', 'enhanced')),
  -- bridge | transak (the adapter that owns this customer)
  provider TEXT,
  -- The provider's own customer/applicant id, once created. NULL until then.
  provider_customer_id TEXT,
  -- unverified | pending | approved | rejected | expired
  status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (status IN ('unverified', 'pending', 'approved', 'rejected', 'expired')),
  -- ISO 3166-1 alpha-2 of the jurisdiction the tier requirements were
  -- derived for (KYC requirements are dynamic per country).
  country TEXT,
  -- Provider-granted limits, in USD cents (1:1 with USDsui). NULL = unset.
  daily_limit_cents BIGINT,
  monthly_limit_cents BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The webhook reconciles by provider customer id, so index it (partial —
-- ignore the NULLs that haven't been assigned a provider customer yet).
CREATE INDEX IF NOT EXISTS idx_onramp_kyc_provider_customer
  ON onramp_kyc (provider_customer_id)
  WHERE provider_customer_id IS NOT NULL;

-- Admin / ops read: "who is pending or rejected?" scans by status.
CREATE INDEX IF NOT EXISTS idx_onramp_kyc_status
  ON onramp_kyc (status);
