import "server-only";

/**
 * USD withdrawal (Bridge USD-wire cash-out) access gate.
 *
 * While USD withdrawal is piloted, it is CLOSED to everyone except an explicit
 * allowlist. This is separate from the general app-access allowlist
 * (lib/app-access.ts) — a user can be fully app-approved yet still not be able
 * to initiate a USD wire withdrawal.
 *
 * Resolution order:
 *   1. `USD_WITHDRAWAL_OPEN=true`  → open to everyone (the "ship it" switch).
 *   2. otherwise, allow only accounts whose email is in
 *      `USD_WITHDRAWAL_ALLOWED_EMAILS` OR whose @handle is in
 *      `USD_WITHDRAWAL_ALLOWED_HANDLES` (both comma-separated, case-insensitive).
 *
 * Defaults (when the env vars are unset) restrict it to the maintainer,
 * `rolandojude18`, so a fresh deploy is closed-by-default without needing the
 * env set. Server-authoritative — the iOS app surfaces the 403 as "coming soon".
 */
const DEFAULT_EMAILS = "rolandojude18@gmail.com";
const DEFAULT_HANDLES = "rolandojude18";

export const USD_WITHDRAWAL_CLOSED_MESSAGE =
  "USD withdrawal isn't open for your account yet — it's rolling out soon.";

function list(envVal: string | undefined, fallback: string): string[] {
  return (envVal ?? fallback)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function usdWithdrawalAllowed(user: {
  email?: string | null;
  talise_username?: string | null;
}): boolean {
  if (process.env.USD_WITHDRAWAL_OPEN?.trim().toLowerCase() === "true") return true;

  const email = user.email?.trim().toLowerCase();
  if (email && list(process.env.USD_WITHDRAWAL_ALLOWED_EMAILS, DEFAULT_EMAILS).includes(email)) {
    return true;
  }
  const handle = user.talise_username?.trim().toLowerCase();
  if (handle && list(process.env.USD_WITHDRAWAL_ALLOWED_HANDLES, DEFAULT_HANDLES).includes(handle)) {
    return true;
  }
  return false;
}
