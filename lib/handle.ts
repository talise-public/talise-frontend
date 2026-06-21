/**
 * Pure helpers for Talise usernames.
 *
 * User-facing form is `name@talise`. The SuiNS canonical form is
 * `name.talise.sui` (the operator owns `talise.sui` and gives users subnames).
 * Both forms strip to the same bare username, which is what we store in DB.
 *
 * No DB, no fetch, no side effects. Safe to import client or server.
 */

export type ParsedHandle = { username: string; raw: string };

/** Hard constraint enforced everywhere: lowercase a-z, 0-9, underscore. 3-20 chars. */
export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

/** Reserved usernames that no user may claim. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "admin",
  "talise",
  "support",
  "help",
  "api",
  "www",
  "root",
]);

/**
 * Strip wrappers (`@`, `@talise`, `.talise.sui`), lowercase, validate.
 * Returns the bare username, or null if the input doesn't conform.
 */
export function normalizeHandle(input: string): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;

  // strip leading `@`
  if (s.startsWith("@")) s = s.slice(1);

  // Talise display forms (must be checked before bare `@talise`):
  if (s.endsWith("@talise.sui")) s = s.slice(0, -"@talise.sui".length);
  // strip `@talise` suffix (short form on cards)
  if (s.endsWith("@talise")) s = s.slice(0, -"@talise".length);
  // SuiNS canonical
  if (s.endsWith(".talise.sui")) s = s.slice(0, -".talise.sui".length);

  if (!USERNAME_RE.test(s)) return null;
  return s;
}

/** Short display form used on cards and chips. */
export function formatHandle(username: string): string {
  return `${username}@talise`;
}

/**
 * Long / canonical user-facing form. Used in error messages and search
 * hints where users need to see exactly which name was looked up. Uses
 * `@` instead of `.` to keep Talise branding consistent — the on-chain
 * SuiNS NameRecord stays the standard `.talise.sui` form.
 */
export function formatHandleFull(username: string): string {
  return `${username}@talise.sui`;
}

/** True if the input looks like a Sui address (0x + 64 hex chars). */
export function isHexAddress(input: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(input);
}
