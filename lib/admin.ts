import "server-only";

/**
 * Admin allowlist — the small set of identities permitted to (a) bypass
 * KYC/tier gates for testing (e.g. cross-border before identity
 * verification ships) and (b) access the local admin dashboard.
 *
 * Matches on EITHER the Google email OR the Talise @handle, since an
 * account carries both (`users.email`, `users.talise_username`). Add an
 * env override (`ADMIN_EXTRA_EMAILS`, comma-separated) so ops can extend
 * the list without a deploy if needed.
 */

const ADMIN_EMAILS = new Set<string>([
  "rolandojude18@gmail.com",
  "exorbilabs@gmail.com",
]);

// Bare handles (no "@", no ".talise.sui"). "eromonsele@talise.sui" → "eromonsele".
const ADMIN_HANDLES = new Set<string>([
  "eromonsele",
]);

function envEmails(): Set<string> {
  const raw = process.env.ADMIN_EXTRA_EMAILS;
  if (!raw) return ADMIN_EMAILS;
  const merged = new Set(ADMIN_EMAILS);
  for (const e of raw.split(",")) {
    const t = e.trim().toLowerCase();
    if (t) merged.add(t);
  }
  return merged;
}

function normalizeHandle(handle: string): string {
  return handle
    .trim()
    .toLowerCase()
    .replace(/\.talise\.sui$/, "")
    .replace(/@talise\.sui$/, "")
    .replace(/^@/, "");
}

/** True if the email matches the admin allowlist. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return envEmails().has(email.trim().toLowerCase());
}

/** True if the @handle (any form) matches the admin allowlist. */
export function isAdminHandle(handle: string | null | undefined): boolean {
  if (!handle) return false;
  return ADMIN_HANDLES.has(normalizeHandle(handle));
}

/**
 * True if a user (by email OR handle) is an admin. The canonical check
 * for gate bypass + dashboard access.
 */
export function isAdminIdentity(
  email: string | null | undefined,
  handle: string | null | undefined
): boolean {
  return isAdminEmail(email) || isAdminHandle(handle);
}
