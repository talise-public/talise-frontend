import "server-only";

import { db } from "@/lib/db";
import type {
  OnrampKycStatus,
  OnrampKycTier,
  OnrampProviderName,
} from "./types";

/**
 * Persistence for the on-ramp KYC record (`onramp_kyc` table).
 *
 * CRITICAL: the migration (web/migrations/2026-06-05-onramp-kyc.sql) is NOT
 * applied, so the table may not exist yet. Every write/read here is wrapped
 * in try/catch and NO-OPS gracefully (logging once) if the table is missing,
 * so nothing throws in dev. This module is DISPLAY/COMPLIANCE-STATE only —
 * it never participates in any send/balance/limit decision.
 *
 * This is intentionally separate from `users.kyc_tier` (lib/kyc.ts), which
 * stays the authoritative send-gate. The on-ramp tier here is the richer,
 * per-provider, per-country model the funding flow needs.
 */

export interface OnrampKycRecord {
  userId: number;
  tier: OnrampKycTier;
  provider: OnrampProviderName | null;
  providerCustomerId: string | null;
  kycLinkId: string | null;
  status: OnrampKycStatus;
  country: string | null;
  dailyLimitCents: number | null;
  monthlyLimitCents: number | null;
}

function isMissingTable(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  // Postgres: 42P01 undefined_table.
  return /relation .* does not exist|42P01|undefined table/i.test(msg);
}

/** Read the on-ramp KYC record for a user, or null (incl. when table absent). */
export async function getOnrampKyc(
  userId: number
): Promise<OnrampKycRecord | null> {
  try {
    const r = await db().execute({
      sql: `SELECT user_id, kyc_tier, provider, provider_customer_id, kyc_link_id,
                   status, country, daily_limit_cents, monthly_limit_cents
            FROM onramp_kyc WHERE user_id = ? LIMIT 1`,
      args: [userId],
    });
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      userId,
      tier: (row.kyc_tier as OnrampKycTier) ?? "none",
      provider: (row.provider as OnrampProviderName) ?? null,
      providerCustomerId: (row.provider_customer_id as string) ?? null,
      kycLinkId: (row.kyc_link_id as string) ?? null,
      status: (row.status as OnrampKycStatus) ?? "unverified",
      country: (row.country as string) ?? null,
      dailyLimitCents: numOrNull(row.daily_limit_cents),
      monthlyLimitCents: numOrNull(row.monthly_limit_cents),
    };
  } catch (err) {
    if (isMissingTable(err)) {
      console.warn(
        "[onramp/kyc-store] onramp_kyc table not present — read no-op. " +
          "Apply web/migrations/2026-06-05-onramp-kyc.sql to enable."
      );
      return null;
    }
    throw err;
  }
}

/**
 * Upsert the on-ramp KYC record from a (verified) provider event or a
 * customer-create result. Only non-undefined fields are written; the row is
 * created on first write. NO-OPS if the table doesn't exist yet.
 */
export async function upsertOnrampKyc(
  userId: number,
  patch: Partial<Omit<OnrampKycRecord, "userId">>
): Promise<boolean> {
  try {
    await db().execute({
      sql: `INSERT INTO onramp_kyc
              (user_id, kyc_tier, provider, provider_customer_id, kyc_link_id,
               status, country, daily_limit_cents, monthly_limit_cents, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now())
            ON CONFLICT (user_id) DO UPDATE SET
              kyc_tier = COALESCE(EXCLUDED.kyc_tier, onramp_kyc.kyc_tier),
              provider = COALESCE(EXCLUDED.provider, onramp_kyc.provider),
              provider_customer_id =
                COALESCE(EXCLUDED.provider_customer_id, onramp_kyc.provider_customer_id),
              kyc_link_id = COALESCE(EXCLUDED.kyc_link_id, onramp_kyc.kyc_link_id),
              status = COALESCE(EXCLUDED.status, onramp_kyc.status),
              country = COALESCE(EXCLUDED.country, onramp_kyc.country),
              daily_limit_cents =
                COALESCE(EXCLUDED.daily_limit_cents, onramp_kyc.daily_limit_cents),
              monthly_limit_cents =
                COALESCE(EXCLUDED.monthly_limit_cents, onramp_kyc.monthly_limit_cents),
              updated_at = now()`,
      args: [
        userId,
        patch.tier ?? "none",
        patch.provider ?? null,
        patch.providerCustomerId ?? null,
        patch.kycLinkId ?? null,
        patch.status ?? "unverified",
        patch.country ?? null,
        patch.dailyLimitCents ?? null,
        patch.monthlyLimitCents ?? null,
      ],
    });
    return true;
  } catch (err) {
    if (isMissingTable(err)) {
      console.warn(
        "[onramp/kyc-store] onramp_kyc table not present — write no-op. " +
          "Apply web/migrations/2026-06-05-onramp-kyc.sql to enable.",
        { userId, patch }
      );
      return false;
    }
    throw err;
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
