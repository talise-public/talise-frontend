import "server-only";

/**
 * USD withdrawal (Bridge USD-wire cash-out) access gate.
 *
 * LOCKED for now (closed by default) while KYC + the US cash-out flow are paused.
 * Re-open to everyone with `USD_WITHDRAWAL_OPEN=true`. The maintainer allowlist
 * (`USD_WITHDRAWAL_ALLOWED_EMAILS` / `_HANDLES`, default `rolandojude18`) always
 * passes so testing keeps working. Cash-out also independently requires approved
 * Bridge KYC. Server-authoritative — the iOS app surfaces the 403 as "coming soon".
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
  // LOCKED for now: closed by default. Flip back on with `USD_WITHDRAWAL_OPEN=true`.
  if (process.env.USD_WITHDRAWAL_OPEN?.trim().toLowerCase() === "true") return true;
  // Otherwise allow only the maintainer allowlist (keeps testing working).
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
